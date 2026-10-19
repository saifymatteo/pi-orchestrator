// Minimal stand-in for @earendil-works/pi-tui, including binary settings input.
export class Container {
	constructor() {
		this.children = [];
	}
	addChild(child) {
		this.children.push(child);
	}
	render(width) {
		return this.children.flatMap((child) => child.render(width));
	}
	invalidate() {}
}
export class SettingsList {
	constructor(items, _maxVisible, _theme, onChange, onCancel) {
		this.items = items;
		this.onChange = onChange;
		this.onCancel = onCancel;
		this.selectedIndex = 0;
	}
	updateValue(id, value) {
		const item = this.items.find((item) => item.id === id);
		if (item) item.currentValue = value;
	}
	handleInput(data) {
		if (data === "\u001b[B") this.selectedIndex = Math.min(this.selectedIndex + 1, this.items.length - 1);
		else if (data === "\u001b[A") this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
		else if (data === " " || data === "\r") {
			const item = this.items[this.selectedIndex];
			if (!item?.values?.length) return;
			item.currentValue = item.values[(item.values.indexOf(item.currentValue) + 1) % item.values.length];
			this.onChange(item.id, item.currentValue);
		} else if (data === "\u001b") this.onCancel();
	}
	render() {
		return this.items.map((item) => `${item.label}: ${item.currentValue}`);
	}
}
export class Markdown {}
export class Spacer {}
export class Text {
	constructor(text) {
		this.text = text;
	}
}
export class Box {
	constructor() {
		this.children = [];
	}
	addChild(child) {
		this.children.push(child);
	}
}
export function truncateToWidth(text) {
	return text;
}
export function visibleWidth() {
	return 0;
}
