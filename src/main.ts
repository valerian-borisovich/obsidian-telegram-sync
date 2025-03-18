import { Plugin } from "obsidian";
import { DEFAULT_SETTINGS, TelegramSyncSettings, TelegramSyncSettingTab } from "./settings/Settings";
import TelegramBot from "node-telegram-bot-api";
import { machineIdSync } from "node-machine-id";
import {
	_15sec,
	_2min,
	displayAndLog,
	StatusMessages,
	displayAndLogError,
	hideMTProtoAlerts,
	_1sec,
	_5sec,
	_day,
} from "./utils/logUtils";
import * as Client from "./telegram/user/client";
import * as Bot from "./telegram/bot/bot";
import * as User from "./telegram/user/user";
import { enqueue } from "./utils/queues";
import { clearTooManyRequestsInterval } from "./telegram/bot/tooManyRequests";
import { clearCachedMessagesInterval } from "./telegram/convertors/botMessageToClientMessage";
import { clearHandleMediaGroupInterval } from "./telegram/bot/message/handlers";
import ConnectionStatusIndicator, { checkConnectionMessage } from "./ConnectionStatusIndicator";
import { mainDeviceIdSettingName } from "./settings/modals/BotSettings";
import {
	createDefaultMessageDistributionRule,
	createDefaultMessageFilterCondition,
	defaultFileNameTemplate,
	defaultMessageFilterQuery,
	defaultNoteNameTemplate,
	defaultTelegramFolder,
} from "./settings/messageDistribution";
import os from "os";
import { clearCachedUnprocessedMessages, forwardUnprocessedMessages } from "./telegram/user/sync";
import { decrypt, encrypt } from "./utils/crypto256";
import { PinCodeModal } from "./settings/modals/PinCode";

// TODO LOW: add "connecting"
export type ConnectionStatus = "connected" | "disconnected";
export type PluginStatus = "unloading" | "unloaded" | "loading" | "loaded";

// Main class for the Telegram Sync plugin
export default class TelegramSyncPlugin extends Plugin {
	settings: TelegramSyncSettings;
	settingsTab?: TelegramSyncSettingTab;
	private botStatus: ConnectionStatus = "disconnected";
	// TODO LOW: change to userStatus and display in status bar
	userConnected = false;
	checkingBotConnection = false;
	checkingUserConnection = false;
	// TODO LOW: TelegramSyncBot extends TelegramBot
	bot?: TelegramBot;
	botUser?: TelegramBot.User;
	createdFilePaths: string[] = [];
	currentDeviceId = machineIdSync(true);
	lastPollingErrors: string[] = [];
	restartingIntervalId?: NodeJS.Timer;
	restartingIntervalTime = _15sec;
	messagesLeftCnt = 0;
	connectionStatusIndicator? = new ConnectionStatusIndicator(this);
	status: PluginStatus = "loading";
	time4processOldMessages = false;
	processOldMessagesIntervalId?: NodeJS.Timer;
	pinCode?: string = undefined;

	async initTelegram(initType?: Client.SessionType) {
		this.lastPollingErrors = [];
		this.messagesLeftCnt = 0;
		if (this.settings.mainDeviceId && this.settings.mainDeviceId !== this.currentDeviceId) {
			this.stopTelegram();
			displayAndLog(
				this,
				`Paused on this device. If you want the plugin to work here, change the value of "${mainDeviceIdSettingName}" to the current device id in the bot settings.`,
				0,
			);
			return;
		}
		// Uncomment timeout to debug if test during plugin loading
		// await new Promise((resolve) => setTimeout(resolve, 3000));

		if (!initType || initType == "user")
			await User.connect(this, this.settings.telegramSessionType, this.settings.telegramSessionId);

		if (!initType || initType == "bot") await Bot.connect(this);

		// restart telegram bot or user if needed
		if (!this.restartingIntervalId) this.setRestartTelegramInterval(this.restartingIntervalTime);

		// start processing old messages
		if (!this.processOldMessagesIntervalId) {
			this.setProcessOldMessagesInterval();
			this.time4processOldMessages = true;
			await this.processOldMessages();
		}
	}

	setRestartTelegramInterval(newRestartingIntervalTime: number, sessionType?: Client.SessionType) {
		this.restartingIntervalTime = newRestartingIntervalTime;
		clearInterval(this.restartingIntervalId);
		this.restartingIntervalId = setInterval(
			async () => await enqueue(this, this.restartTelegram, sessionType),
			this.restartingIntervalTime,
		);
	}

	setProcessOldMessagesInterval() {
		this.clearProcessOldMessagesInterval();
		this.processOldMessagesIntervalId = setInterval(async () => {
			this.time4processOldMessages = true;
			await enqueue(this, this.processOldMessages);
		}, _day);
	}

	clearProcessOldMessagesInterval() {
		clearInterval(this.processOldMessagesIntervalId);
		this.processOldMessagesIntervalId = undefined;
		this.time4processOldMessages = false;
	}

	async restartTelegram(sessionType?: Client.SessionType) {
		let needRestartInterval = false;
		try {
			if (
				(!sessionType || sessionType == "user") &&
				!this.userConnected &&
				!this.checkingUserConnection &&
				this.settings.telegramSessionType == "user"
			) {
				await this.initTelegram("user");
				needRestartInterval = true;
			}

			if (
				(!sessionType || sessionType == "bot") &&
				!this.isBotConnected() &&
				!this.checkingBotConnection &&
				this.settings?.botToken
			) {
				await this.initTelegram("bot");
				needRestartInterval = true;
			}

			if (needRestartInterval) this.setRestartTelegramInterval(_15sec);
			else if (this.bot && !sessionType && os.type() == "Darwin" && this.isBotConnected()) {
				try {
					this.botUser = await this.bot.getMe();
				} catch {
					this.setBotStatus("disconnected");
					this.userConnected = false;
				}
			}
		} catch {
			this.setRestartTelegramInterval(
				this.restartingIntervalTime < _2min ? this.restartingIntervalTime * 2 : this.restartingIntervalTime,
			);
		}
	}

	async processOldMessages() {
		if (!this.time4processOldMessages) return;
		if (!this.settings.processOldMessages) clearCachedUnprocessedMessages();
		if (!this.userConnected || !this.settings.processOldMessages || !this.botUser) return;
		try {
			await forwardUnprocessedMessages(this);
		} finally {
			this.time4processOldMessages = false;
		}
	}

	stopTelegram() {
		this.checkingBotConnection = false;
		this.checkingUserConnection = false;
		this.clearProcessOldMessagesInterval();
		clearInterval(this.restartingIntervalId);
		this.restartingIntervalId = undefined;
		Bot.disconnect(this);
		User.disconnect(this);
	}

	// Load the plugin, settings, and initialize the bot
	async onload() {
		this.status = "loading";

		await this.loadSettings();
		await this.upgradeSettings();

		// Add a settings tab for this plugin
		this.settingsTab = new TelegramSyncSettingTab(this.app, this);
		this.addSettingTab(this.settingsTab);

		hideMTProtoAlerts(this);
		// Initialize the Telegram bot when Obsidian layout is fully loaded
		this.app.workspace.onLayoutReady(async () => {
			enqueue(this, this.initTelegram);
		});

		this.status = "loaded";
		displayAndLog(this, this.status, 0);
	}

	async onunload(): Promise<void> {
		this.status = "unloading";
		try {
			clearTooManyRequestsInterval();
			clearCachedMessagesInterval();
			clearHandleMediaGroupInterval();
			this.connectionStatusIndicator?.destroy();
			this.connectionStatusIndicator = undefined;
			this.settingsTab = undefined;
			this.stopTelegram();
		} catch (e) {
			displayAndLog(this, e, 0);
		} finally {
			this.status = "unloaded";
			displayAndLog(this, this.status, 0);
		}
	}

	// Load settings from the plugin's data
	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	// Save settings to the plugin's data
	async saveSettings() {
		await this.saveData(this.settings);
	}

	async upgradeSettings() {
		let needToSaveSettings = false;
		if (this.settings.cacheCleanupAtStartup) {
			localStorage.removeItem("GramJs:apiCache");
			this.settings.cacheCleanupAtStartup = false;
			needToSaveSettings = true;
		}

		if (this.settings.messageDistributionRules.length == 0) {
			this.settings.messageDistributionRules.push(createDefaultMessageDistributionRule());
			needToSaveSettings = true;
		} else {
			// fixing incorrectly saved rules
			this.settings.messageDistributionRules.forEach((rule) => {
				if (!rule.messageFilterQuery || !rule.messageFilterConditions) {
					rule.messageFilterQuery = defaultMessageFilterQuery;
					rule.messageFilterConditions = [createDefaultMessageFilterCondition()];
					needToSaveSettings = true;
				}
				if (!rule.filePathTemplate && !rule.notePathTemplate && !rule.templateFilePath) {
					rule.notePathTemplate = `${defaultTelegramFolder}/${defaultNoteNameTemplate}`;
					rule.filePathTemplate = `${defaultTelegramFolder}/${defaultFileNameTemplate}`;
					needToSaveSettings = true;
				}
			});
		}

		if (!this.settings.botTokenEncrypted) {
			this.botTokenEncrypt();
			needToSaveSettings = true;
		}

		needToSaveSettings && (await this.saveSettings());
	}

	async getBotUser(): Promise<TelegramBot.User> {
		this.botUser = this.botUser || (await this.bot?.getMe());
		if (!this.botUser) throw new Error("Can't get access to bot info. Restart the Telegram Sync plugin");
		return this.botUser;
	}

	isBotConnected(): boolean {
		return this.botStatus === "connected";
	}

	async setBotStatus(status: ConnectionStatus, error?: Error) {
		if (this.botStatus == status && !error) return;

		this.botStatus = status;
		this.connectionStatusIndicator?.update(error);

		if (this.isBotConnected()) displayAndLog(this, StatusMessages.BOT_CONNECTED, 0);
		else if (!error) displayAndLog(this, StatusMessages.BOT_DISCONNECTED, 0);
		else displayAndLogError(this, error, StatusMessages.BOT_DISCONNECTED, checkConnectionMessage, undefined, 0);
	}

	async getBotToken(): Promise<string> {
		if (!this.settings.botTokenEncrypted) return this.settings.botToken;

		if (this.settings.encryptionByPinCode && !this.pinCode) {
			await new Promise((resolve) => {
				const pinCodeModal = new PinCodeModal(this, true);
				pinCodeModal.onClose = async () => {
					if (!this.pinCode) displayAndLog(this, "Plugin Telegram Sync stopped. No pin code entered.");
					resolve(undefined);
				};
				pinCodeModal.open();
			});
		}
		return decrypt(this.settings.botToken, this.pinCode);
	}

	botTokenEncrypt(saveSettings = false) {
		this.settings.botToken = encrypt(this.settings.botToken, this.pinCode);
		this.settings.botTokenEncrypted = true;
		saveSettings && this.saveSettings();
		displayAndLog(this, "Bot token encrypted", 0);
	}
}
