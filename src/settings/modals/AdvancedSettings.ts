import { Modal, Setting } from "obsidian";
import TelegramSyncPlugin from "src/main";
import { _1sec, _5sec } from "src/utils/logUtils";
import {
	ConnectionStatusIndicatorType,
	KeysOfConnectionStatusIndicatorType,
	connectionStatusIndicatorSettingName,
} from "src/ConnectionStatusIndicator";

export class AdvancedSettingsModal extends Modal {
	advancedSettingsDiv: HTMLDivElement;
	saved = false;
	constructor(public plugin: TelegramSyncPlugin) {
		super(plugin.app);
	}

	async display() {
		this.addHeader();

		this.addConnectionStatusIndicator();
		this.addDeleteMessagesFromTelegram();
		this.addMessageDelimiterSetting();
		this.addParallelMessageProcessing();
		this.addDeleteReplayMessages();
	}

	addHeader() {
		this.contentEl.empty();
		this.advancedSettingsDiv = this.contentEl.createDiv();
		this.titleEl.setText("Advanced settings");
	}

	addMessageDelimiterSetting() {
		new Setting(this.advancedSettingsDiv)
			.setName(`Default delimiter "***" between messages`)
			.setDesc("Turn off for using a custom delimiter, which you can set in the template file")
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.defaultMessageDelimiter);
				toggle.onChange(async (value) => {
					this.plugin.settings.defaultMessageDelimiter = value;
					await this.plugin.saveSettings();
				});
			});
	}

	addParallelMessageProcessing() {
		new Setting(this.advancedSettingsDiv)
			.setName(`Parallel message processing`)
			.setDesc("Turn on for faster message and file processing. Caution: may disrupt message order")
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.parallelMessageProcessing);
				toggle.onChange(async (value) => {
					this.plugin.settings.parallelMessageProcessing = value;
					await this.plugin.saveSettings();
				});
			});
	}

	addConnectionStatusIndicator() {
		new Setting(this.advancedSettingsDiv)
			.setName(connectionStatusIndicatorSettingName)
			.setDesc("Choose when you want to see the connection status indicator")
			.addDropdown((dropDown) => {
				dropDown.addOptions(ConnectionStatusIndicatorType);
				dropDown.setValue(this.plugin.settings.connectionStatusIndicatorType);
				dropDown.onChange(async (value) => {
					this.plugin.settings.connectionStatusIndicatorType = value as KeysOfConnectionStatusIndicatorType;
					this.plugin.connectionStatusIndicator?.update();
					await this.plugin.saveSettings();
				});
			});
	}

	addDeleteMessagesFromTelegram() {
		new Setting(this.advancedSettingsDiv)
			.setName("Delete messages from Telegram")
			.setDesc(
				"The Telegram messages will be deleted after processing them. If disabled, the Telegram messages will be marked as processed",
			)
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.deleteMessagesFromTelegram);
				toggle.onChange(async (value) => {
					this.plugin.settings.deleteMessagesFromTelegram = value;
					await this.plugin.saveSettings();
				});
			});
	}

	addDeleteReplayMessages() {
		new Setting(this.advancedSettingsDiv)
			.setName("Delete replay message after few seconds.")
			.setDesc("Seconds")
			.addText((text) => {
				let s: number = 0;
				if (this.plugin.settings.deleteReplayMessages!==0){
					
					s = this.plugin.settings.deleteReplayMessages/_1sec;
				}
				text.setValue(s.toString())
				text.setPlaceholder("example: 5").onChange(async (value: string) => {
					if (!value) {
						text.inputEl.style.borderColor = "red";
						text.inputEl.style.borderWidth = "2px";
						text.inputEl.style.borderStyle = "solid";
					}
					this.plugin.settings.deleteReplayMessages = parseInt(value) * _1sec;
					await this.plugin.saveSettings();
				});
				// text.inputEl.addEventListener("keydown", (event: KeyboardEvent) => {if (!(event.key === "Enter")) return;});
			});
	}

	onOpen() {
		this.display();
	}
}
