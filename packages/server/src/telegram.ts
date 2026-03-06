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
        console.error(`Telegram setMyCommands error (${response.status}): ${body}`);
        return;
      }

      const data = (await response.json()) as { ok: boolean; description?: string };
      if (!data.ok) {
        console.error(`Telegram setMyCommands rejected: ${data.description ?? 'unknown error'}`);
        return;
      }

      console.log(`Telegram commands synced (${commands.length})`);
    } catch (error) {
      console.error('Telegram setMyCommands failed:', error);
    }
  }

  startCommandPolling(): void {
    if (this.polling || !this.botToken) return;
    this.polling = true;
    console.log('Telegram bot command polling started');
    void this.pollUpdates();
  }

  stopCommandPolling(): void {
    this.polling = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    console.log('Telegram bot command polling stopped');
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
        console.error(`Telegram getUpdates error (${response.status}): ${body}`);
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'TimeoutError')) {
        console.error('Telegram poll error:', error);
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
        console.error(`Error handling /${command}:`, error);
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
        console.error(`Telegram API error (${response.status}): ${body}`);
        return false;
      }

      return true;
    } catch (error) {
      console.error('Telegram send failed:', error);
      return false;
    }
  }
}
