export type CommandHandler = (chatId: string, args: string) => Promise<void>;
export type TelegramBotCommand = {
  command: string;
  description: string;
};

type TelegramUpdate = {
  update_id: number;
  message?: {
    chat: { id: number };
    text?: string;
  };
};

import { logger } from './logger.js';

export class TelegramClient {
  private readonly botToken: string;
  private readonly commands = new Map<string, CommandHandler>();
  private updateOffset = 0;
  private polling = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(botToken: string) {
    this.botToken = botToken;
  }

  onCommand(command: string, handler: CommandHandler): void {
    this.commands.set(command, handler);
  }

  async syncCommands(commands: TelegramBotCommand[]): Promise<void> {
    if (!this.botToken) return;

    try {
      const response = await fetch(`https://api.telegram.org/bot${this.botToken}/setMyCommands`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ commands }),
      });

      if (!response.ok) {
        const body = await response.text();
        logger.error({ status: response.status, body }, 'Telegram setMyCommands error');
        return;
      }

      const data = (await response.json()) as { ok: boolean; description?: string };
      if (!data.ok) {
        logger.error(
          { description: data.description ?? 'unknown error' },
          'Telegram setMyCommands rejected',
        );
        return;
      }

      logger.info({ count: commands.length }, 'Telegram commands synced');
    } catch (error) {
      logger.error({ err: error }, 'Telegram setMyCommands failed');
    }
  }

  startCommandPolling(): void {
    if (this.polling || !this.botToken) return;
    this.polling = true;
    logger.info('Telegram bot command polling started');
    void this.pollUpdates();
  }

  stopCommandPolling(): void {
    this.polling = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    logger.info('Telegram bot command polling stopped');
  }

  private async pollUpdates(): Promise<void> {
    if (!this.polling) return;

    try {
      const response = await fetch(
        `https://api.telegram.org/bot${this.botToken}/getUpdates?` +
          new URLSearchParams({
            offset: String(this.updateOffset),
            timeout: '30',
            allowed_updates: JSON.stringify(['message']),
          }),
        { signal: AbortSignal.timeout(35_000) },
      );

      if (response.ok) {
        const data = (await response.json()) as { ok: boolean; result: TelegramUpdate[] };
        if (data.ok && data.result.length > 0) {
          for (const update of data.result) {
            this.updateOffset = update.update_id + 1;
            await this.handleUpdate(update);
          }
        }
      } else {
        const body = await response.text();
        logger.error({ status: response.status, body }, 'Telegram getUpdates error');
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'TimeoutError')) {
        logger.error({ err: error }, 'Telegram poll error');
      }
    }

    if (this.polling) {
      this.pollTimer = setTimeout(() => void this.pollUpdates(), 500);
    }
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    const text = update.message?.text;
    const chatId = update.message?.chat.id;
    if (!text || chatId === undefined) return;

    // Parse "/command args" or "/command@botname args"
    const match = text.match(/^\/(\w+)(?:@\S+)?\s*(.*)/s);
    if (!match) return;

    const [, command, args] = match;
    const handler = this.commands.get(command!);
    if (handler) {
      try {
        await handler(String(chatId), args!.trim());
      } catch (error) {
        logger.error({ err: error, command }, 'Error handling Telegram command');
        await this.sendMessage(String(chatId), `Error processing /${command}. Please try again.`);
      }
    }
  }

  async sendMessage(chatId: string, text: string): Promise<boolean> {
    try {
      const response = await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        logger.error({ status: response.status, body }, 'Telegram API error');
        return false;
      }

      return true;
    } catch (error) {
      logger.error({ err: error }, 'Telegram send failed');
      return false;
    }
  }
}
