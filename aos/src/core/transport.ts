/**
 * Transports are the only place a provider difference is allowed to exist, and
 * only callModel() in router.ts is allowed to reach them. Swapping providers is
 * a config change (constraint C3).
 *
 *   http   - any OpenAI-compatible /chat/completions endpoint. That covers
 *            OpenRouter, OpenAI, Groq, Together, and most corporate gateways,
 *            which is why the shape was chosen over a per-vendor SDK.
 *   replay - answers from a previous run's events.jsonl. Zero API calls.
 *   mock   - a deterministic offline stand-in so the machine can be exercised
 *            without a key. It is not a model and never pretends to be one.
 */
import { AosError } from './errors.ts';
import { isMockModel } from './catalog.ts';
import type { TokenUsage } from './events.ts';
import { estimatePromptTokens, estimateTokens } from './cost.ts';

export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface TransportRequest {
  model: string;
  messages: Message[];
  temperature: number;
  maxTokens: number;
  /** Ask the endpoint for JSON when it supports it. Never trusted on its own. */
  jsonMode: boolean;
  hash: string;
}

export interface TransportResponse {
  text: string;
  usage: TokenUsage;
}

export interface Transport {
  readonly kind: 'http' | 'replay' | 'mock';
  send(req: TransportRequest): Promise<TransportResponse>;
}

export interface HttpTransportOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  referer?: string;
  title?: string;
}

export function httpTransport(opts: HttpTransportOptions): Transport {
  const url = `${opts.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const timeoutMs = opts.timeoutMs ?? 120_000;

  return {
    kind: 'http',
    async send(req) {
      if (isMockModel(req.model)) {
        throw new AosError('ROUTER', `refusing to send offline stub slug "${req.model}" to a live router`, {
          model: req.model,
          hint: 'Run `npm run setup` against a real router to write real slugs into config/routing.yaml.',
        });
      }

      const body: Record<string, unknown> = {
        model: req.model,
        messages: req.messages,
        temperature: req.temperature,
        max_tokens: req.maxTokens,
      };
      if (req.jsonMode) body.response_format = { type: 'json_object' };

      const headers: Record<string, string> = {
        'content-type': 'application/json',
        authorization: `Bearer ${opts.apiKey}`,
      };
      if (opts.referer) headers['http-referer'] = opts.referer;
      if (opts.title) headers['x-title'] = opts.title;

      let res: Response;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        throw new AosError('ROUTER', `request to ${url} failed: ${(err as Error).message}`, { model: req.model });
      }

      const raw = await res.text();
      if (!res.ok) {
        throw new AosError('ROUTER', `router returned HTTP ${res.status} for ${req.model}`, {
          status: res.status,
          body: raw.slice(0, 600),
        });
      }

      let parsed: {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
        error?: { message?: string };
      };
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new AosError('ROUTER', `router returned a non-JSON body for ${req.model}`, { body: raw.slice(0, 600) });
      }
      if (parsed.error) {
        throw new AosError('ROUTER', `router error for ${req.model}: ${parsed.error.message ?? 'unknown'}`, {});
      }

      const text = parsed.choices?.[0]?.message?.content;
      if (typeof text !== 'string' || text.length === 0) {
        throw new AosError('ROUTER', `router returned an empty completion for ${req.model}`, {
          body: raw.slice(0, 600),
        });
      }

      // Some gateways omit usage. Fall back to the estimate so the meter never
      // silently records zero for a call that actually cost money.
      return {
        text,
        usage: {
          promptTokens: parsed.usage?.prompt_tokens ?? estimatePromptTokens(req.messages),
          completionTokens: parsed.usage?.completion_tokens ?? estimateTokens(text),
        },
      };
    },
  };
}

/** Replays a prior run. Any call the prior run did not make is a hard failure. */
export function replayTransport(byHash: Map<string, { text: string; usage: TokenUsage }>): Transport {
  return {
    kind: 'replay',
    async send(req) {
      const hit = byHash.get(req.hash);
      if (!hit) {
        throw new AosError('REPLAY_MISS', `no recorded response for ${req.model} (hash ${req.hash.slice(0, 12)})`, {
          model: req.model,
          hash: req.hash,
          hint: 'The pipeline logic changed the prompt, so the recorded run no longer covers it.',
        });
      }
      return hit;
    },
  };
}

export type MockResponder = (req: TransportRequest) => string;

export function mockTransport(respond: MockResponder): Transport {
  return {
    kind: 'mock',
    async send(req) {
      const text = respond(req);
      return {
        text,
        usage: { promptTokens: estimatePromptTokens(req.messages), completionTokens: estimateTokens(text) },
      };
    },
  };
}
