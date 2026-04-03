/**
 * AI SDK provider registry — maps provider profiles to ai-sdk model instances.
 */
import { createProviderRegistry } from 'ai';
import type { ProviderRegistryProvider } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import type { ProvidersOutput } from '../config/validation.js';

const DEFAULT_CONTEXT_WINDOW = 200_000;

export type { ProviderRegistryProvider };

export function buildProviderRegistry(
  providers: ProvidersOutput,
): ProviderRegistryProvider {
  const entries: Record<
    string,
    ReturnType<typeof createAnthropic> | ReturnType<typeof createOpenAI>
  > = {};

  for (const [name, profile] of Object.entries(providers.profiles)) {
    const providerType = profile.provider ?? 'anthropic';

    if (providerType === 'openai') {
      // Use .chat() for OpenAI-compatible proxies — the default in @ai-sdk/openai v3
      // is the Responses API (/v1/responses) which non-OpenAI endpoints don't support.
      const openai = createOpenAI({
        apiKey: profile.api_key,
        baseURL: profile.api_url,
      });
      entries[name] = {
        languageModel: (id: string) => openai.chat(id),
        textEmbeddingModel: (id: string) => openai.embeddingModel(id),
      } as ReturnType<typeof createOpenAI>;
    } else {
      // Default: anthropic
      if (profile.type === 'oauth') {
        const token = profile.oauth_token_env
          ? process.env[profile.oauth_token_env]
          : undefined;
        entries[name] = createAnthropic({
          apiKey: token,
          baseURL: profile.api_url,
        });
      } else {
        entries[name] = createAnthropic({
          apiKey: profile.api_key,
          baseURL: profile.api_url,
        });
      }
    }
  }

  return createProviderRegistry(entries);
}

export function resolveModel(
  registry: ProviderRegistryProvider,
  profileName: string,
  modelId: string,
): ReturnType<ProviderRegistryProvider['languageModel']> {
  return registry.languageModel(`${profileName}:${modelId}`);
}

export function getContextWindow(
  providers: ProvidersOutput,
  profileName: string,
): number {
  const profile = providers.profiles[profileName];
  return profile?.context_window ?? DEFAULT_CONTEXT_WINDOW;
}
