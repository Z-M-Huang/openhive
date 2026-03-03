import { useState } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import { useConfig, useProviders, useUpdateConfig, useUpdateProviders } from '../hooks/useApi';
import type { MasterConfig, Provider } from '../hooks/useApi';
import { MaskedInput } from '../components/settings/MaskedInput';
import { cn } from '../lib/utils';

/**
 * Settings page with tabs for System, Channels, and Providers configuration.
 * Secrets are always masked — the server returns masked values.
 */
export function Settings(): React.JSX.Element {
  const { data: config, isLoading: configLoading, isError: configError } = useConfig();
  const { data: providers, isLoading: providersLoading, isError: providersError } = useProviders();

  if (configLoading || providersLoading) {
    return (
      <div data-testid="settings-page">
        <h1 className="text-2xl font-bold mb-6">Settings</h1>
        <p className="text-sm text-muted-foreground">Loading settings...</p>
      </div>
    );
  }

  if (configError || providersError) {
    return (
      <div data-testid="settings-page">
        <h1 className="text-2xl font-bold mb-6">Settings</h1>
        <p className="text-sm text-destructive">Error loading settings</p>
      </div>
    );
  }

  return (
    <div data-testid="settings-page">
      <h1 className="text-2xl font-bold mb-6">Settings</h1>
      <Tabs.Root defaultValue="system" className="w-full">
        <Tabs.List
          className="flex border-b border-border mb-6"
          aria-label="Settings tabs"
          data-testid="settings-tabs"
        >
          {(['system', 'channels', 'providers'] as const).map(tab => (
            <Tabs.Trigger
              key={tab}
              value={tab}
              className={cn(
                'px-4 py-2 text-sm font-medium capitalize border-b-2 -mb-px transition-colors',
                'border-transparent text-muted-foreground hover:text-foreground',
                'data-[state=active]:border-primary data-[state=active]:text-foreground',
              )}
              data-testid={`settings-tab-${tab}`}
            >
              {tab}
            </Tabs.Trigger>
          ))}
        </Tabs.List>

        <Tabs.Content value="system">
          {config && <SystemTab config={config} />}
        </Tabs.Content>

        <Tabs.Content value="channels">
          {config && <ChannelsTab config={config} />}
        </Tabs.Content>

        <Tabs.Content value="providers">
          {providers && <ProvidersTab providers={providers} />}
        </Tabs.Content>
      </Tabs.Root>
    </div>
  );
}

// --- System Tab ---

function SystemTab({ config }: { config: MasterConfig }): React.JSX.Element {
  const [logLevel, setLogLevel] = useState(config.system.log_level);
  const updateConfig = useUpdateConfig();

  const handleSave = (): void => {
    void updateConfig.mutate({ system: { ...config.system, log_level: logLevel } });
  };

  return (
    <div className="space-y-4 max-w-lg" data-testid="system-form">
      <div>
        <label className="text-sm font-medium" htmlFor="listen-address">
          Listen address
        </label>
        <input
          id="listen-address"
          type="text"
          value={config.system.listen_address}
          readOnly
          className="mt-1 w-full rounded-md border border-input bg-muted px-3 py-2 text-sm text-muted-foreground"
          aria-readonly="true"
        />
        <p className="text-xs text-muted-foreground mt-1">Requires restart to change.</p>
      </div>

      <div>
        <label className="text-sm font-medium" htmlFor="log-level">
          Log level
        </label>
        <select
          id="log-level"
          value={logLevel}
          onChange={e => setLogLevel(e.target.value)}
          className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          data-testid="system-log-level"
        >
          {['debug', 'info', 'warn', 'error'].map(l => (
            <option key={l} value={l}>{l}</option>
          ))}
        </select>
      </div>

      <div>
        <label className="text-sm font-medium" htmlFor="data-dir">
          Data directory
        </label>
        <input
          id="data-dir"
          type="text"
          value={config.system.data_dir}
          readOnly
          className="mt-1 w-full rounded-md border border-input bg-muted px-3 py-2 text-sm text-muted-foreground"
        />
      </div>

      {updateConfig.isError && (
        <p className="text-sm text-destructive">Failed to save settings.</p>
      )}
      {updateConfig.isSuccess && (
        <p className="text-sm text-green-600">Settings saved.</p>
      )}

      <button
        type="button"
        onClick={handleSave}
        disabled={updateConfig.isPending}
        className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        data-testid="system-save"
      >
        {updateConfig.isPending ? 'Saving...' : 'Save'}
      </button>
    </div>
  );
}

// --- Channels Tab ---

interface ChannelFormProps {
  name: string;
  config: { enabled: boolean; token?: string; channel_id?: string; store_path?: string };
  onUpdate: (updates: Partial<{ enabled: boolean; token: string; channel_id: string; store_path: string }>) => void;
}

function ChannelForm({ name, config, onUpdate }: ChannelFormProps): React.JSX.Element {
  return (
    <div className="rounded-lg border border-border p-4 space-y-3" data-testid={`channel-form-${name.toLowerCase()}`}>
      <div className="flex items-center justify-between">
        <h3 className="font-medium capitalize">{name}</h3>
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'h-2 w-2 rounded-full',
              config.enabled ? 'bg-green-500' : 'bg-gray-400',
            )}
            aria-label={config.enabled ? 'Connected' : 'Disconnected'}
            data-testid={`channel-status-${name.toLowerCase()}`}
          />
          <label className="flex items-center gap-1 text-sm">
            <input
              type="checkbox"
              checked={config.enabled}
              onChange={e => onUpdate({ enabled: e.target.checked })}
              className="rounded"
            />
            Enabled
          </label>
        </div>
      </div>

      {config.channel_id !== undefined && (
        <div>
          <label className="text-sm font-medium" htmlFor={`${name}-channel-id`}>
            Channel ID
          </label>
          <input
            id={`${name}-channel-id`}
            type="text"
            value={config.channel_id ?? ''}
            onChange={e => onUpdate({ channel_id: e.target.value })}
            className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
        </div>
      )}

      {config.store_path !== undefined && (
        <div>
          <label className="text-sm font-medium" htmlFor={`${name}-store-path`}>
            Store path
          </label>
          <input
            id={`${name}-store-path`}
            type="text"
            value={config.store_path ?? ''}
            onChange={e => onUpdate({ store_path: e.target.value })}
            className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
        </div>
      )}

      <div>
        <label className="text-sm font-medium">Access credential</label>
        <MaskedInput
          maskedValue={config.token ?? ''}
          onChange={val => onUpdate({ token: val })}
          className="mt-1"
        />
      </div>
    </div>
  );
}

function ChannelsTab({ config }: { config: MasterConfig }): React.JSX.Element {
  const [discordUpdates, setDiscordUpdates] = useState<Partial<typeof config.channels.discord>>({});
  const [whatsappUpdates, setWhatsappUpdates] = useState<Partial<typeof config.channels.whatsapp>>({});
  const updateConfig = useUpdateConfig();

  const handleSave = (): void => {
    void updateConfig.mutate({
      channels: {
        discord: { ...config.channels.discord, ...discordUpdates },
        whatsapp: { ...config.channels.whatsapp, ...whatsappUpdates },
      },
    });
  };

  return (
    <div className="space-y-4 max-w-lg" data-testid="channels-form">
      <ChannelForm
        name="Discord"
        config={{ ...config.channels.discord, ...discordUpdates }}
        onUpdate={updates => setDiscordUpdates(prev => ({ ...prev, ...updates }))}
      />
      <ChannelForm
        name="WhatsApp"
        config={{ ...config.channels.whatsapp, ...whatsappUpdates }}
        onUpdate={updates => setWhatsappUpdates(prev => ({ ...prev, ...updates }))}
      />

      {updateConfig.isError && (
        <p className="text-sm text-destructive">Failed to save channel settings.</p>
      )}
      {updateConfig.isSuccess && (
        <p className="text-sm text-green-600">Channel settings saved.</p>
      )}

      <button
        type="button"
        onClick={handleSave}
        disabled={updateConfig.isPending}
        className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        data-testid="channels-save"
      >
        {updateConfig.isPending ? 'Saving...' : 'Save channels'}
      </button>
    </div>
  );
}

// --- Providers Tab ---

function ProviderRow({
  name,
  provider,
  onDelete,
}: {
  name: string;
  provider: Provider;
  onDelete: (name: string) => void;
}): React.JSX.Element {
  return (
    <div
      className="rounded-lg border border-border p-4 space-y-2"
      data-testid={`provider-row-${name}`}
    >
      <div className="flex items-center justify-between">
        <span className="font-medium text-sm">{name}</span>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground capitalize">{provider.type}</span>
          <button
            type="button"
            onClick={() => onDelete(name)}
            className="text-xs text-destructive hover:underline"
            aria-label={`Delete provider ${name}`}
          >
            Delete
          </button>
        </div>
      </div>

      {(provider.oauth_token !== undefined && provider.oauth_token !== '') && (
        <div className="text-sm">
          <span className="text-muted-foreground">OAuth: </span>
          <span className="font-mono text-xs" data-testid={`provider-oauth-${name}`}>
            {provider.oauth_token}
          </span>
        </div>
      )}

      {(provider.api_key !== undefined && provider.api_key !== '') && (
        <div className="text-sm">
          <span className="text-muted-foreground">API key: </span>
          <span className="font-mono text-xs" data-testid={`provider-apikey-${name}`}>
            {provider.api_key}
          </span>
        </div>
      )}
    </div>
  );
}

function ProvidersTab({
  providers,
}: {
  providers: Record<string, Provider>;
}): React.JSX.Element {
  const [localProviders, setLocalProviders] = useState(providers);
  const updateProviders = useUpdateProviders();

  const handleDelete = (name: string): void => {
    setLocalProviders(prev => {
      const next = { ...prev };
      delete next[name];
      return next;
    });
  };

  const handleSave = (): void => {
    void updateProviders.mutate(localProviders);
  };

  return (
    <div className="space-y-4 max-w-lg" data-testid="providers-form">
      {Object.keys(localProviders).length === 0 ? (
        <p className="text-sm text-muted-foreground">No providers configured.</p>
      ) : (
        Object.entries(localProviders).map(([name, provider]) => (
          <ProviderRow
            key={name}
            name={name}
            provider={provider}
            onDelete={handleDelete}
          />
        ))
      )}

      {updateProviders.isError && (
        <p className="text-sm text-destructive">Failed to save providers.</p>
      )}
      {updateProviders.isSuccess && (
        <p className="text-sm text-green-600">Providers saved.</p>
      )}

      <button
        type="button"
        onClick={handleSave}
        disabled={updateProviders.isPending}
        className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        data-testid="providers-save"
      >
        {updateProviders.isPending ? 'Saving...' : 'Save providers'}
      </button>
    </div>
  );
}
