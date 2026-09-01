// Minimal stand-in for @earendil-works/pi-tui — type/parse coverage only.
export class Container {
	constructor() {
		this.children = [];
	}
	addChild(child) {
		this.children.push(child);
	}
}
export class SettingsList {}
export class Markdown {}
export class Spacer {}
export class Text {
	constructor(text) {
		this.text = text;
	}
}
