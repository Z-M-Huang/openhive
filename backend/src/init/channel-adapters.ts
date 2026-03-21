/**
 * Channel adapter wiring for CLI, Discord, and Slack.
 *
 * @module init/channel-adapters
 */

import { ChannelType } from '../domain/enums.js';
import type { Logger } from '../domain/interfaces.js';
import { DiscordAdapter } from '../channels/discord.js';
import type { MessageRouterImpl } from '../channels/router.js';
import type { ShutdownState } from './types.js';

export interface ChannelAdapterConfig {
  channels: {
    discord: { enabled: boolean; token?: string };
    slack: { enabled: boolean; token?: string };
  };
}

/**
 * Wires up CLI, Discord, and Slack channel adapters based on config.
 */
export async function initializeChannelAdapters(
  messageRouter: MessageRouterImpl,
  masterConfig: ChannelAdapterConfig,
  logger: Logger,
  shutdownState: ShutdownState,
): Promise<void> {
  // CLI adapter -- always enabled in root mode when stdin is TTY
  if (process.stdin.isTTY) {
    const { CLIAdapter } = await import('../channels/cli.js');
    const cliAdapter = new CLIAdapter();
    await cliAdapter.connect();
    messageRouter.registerChannel(ChannelType.Cli, cliAdapter);
    logger.info('CLI channel adapter connected');
  }

  // Discord adapter -- enabled via config, token from YAML or env
  if (masterConfig.channels.discord.enabled) {
    const discordToken = masterConfig.channels.discord.token
      || process.env['DISCORD_BOT_TOKEN'];
    if (discordToken) {
      const discordAdapter = new DiscordAdapter(discordToken);
      try {
        await discordAdapter.connect();
        messageRouter.registerChannel(ChannelType.Discord, discordAdapter);
        shutdownState.discordAdapter = discordAdapter;
        logger.info('Discord adapter connected');
      } catch (err) {
        logger.error('Failed to connect Discord adapter', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      logger.warn('Discord enabled but no token set (channels.discord.token in openhive.yaml or DISCORD_BOT_TOKEN env)');
    }
  }

  // Slack adapter -- enabled via config, token from YAML or env
  if (masterConfig.channels.slack.enabled) {
    const slackToken = masterConfig.channels.slack.token || process.env['SLACK_BOT_TOKEN'];
    if (slackToken) {
      const { SlackAdapter } = await import('../channels/slack.js');
      const slackAdapter = new SlackAdapter(slackToken);
      try {
        await slackAdapter.connect();
        messageRouter.registerChannel(ChannelType.Slack, slackAdapter);
        shutdownState.slackAdapter = slackAdapter;
        logger.info('Slack adapter connected');
      } catch (err) {
        logger.error('Failed to connect Slack adapter', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      logger.warn('Slack enabled but no token set (channels.slack.token in openhive.yaml or SLACK_BOT_TOKEN env)');
    }
  }
}
