type OutputFormat = 'webp' | 'avif';

type AvifEncodeRequest = {
	type: 'encode-avif';
	id: number;
	width: number;
	height: number;
	rgba: ArrayBuffer;
	quality: number; // 0.0 - 1.0
};

type AvifEncodeResponse =
	| { type: 'encode-avif-result'; id: number; ok: true; mime: 'image/avif'; bytes: ArrayBuffer }
	| { type: 'encode-avif-result'; id: number; ok: false; error: string };

type ItemStatus = 'ready' | 'converting' | 'done' | 'error';
type Item = {
	id: number;
	file: File;
	inputUrl: string;
	status: ItemStatus;
	outputBlob: Blob | null;
	outputMime: string | null;
	outputSize: number | null;
	error: string | null;
};

function assertEl<T extends Element>(el: T | null, name: string): T {
	if (!el) throw new Error(`Missing element: ${name}`);
	return el;
}

function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return '-';
	const units = ['B', 'KB', 'MB', 'GB'] as const;
	let value = bytes;
	let unitIndex = 0;
	while (value >= 1024 && unitIndex < units.length - 1) {
		value /= 1024;
		unitIndex++;
	}
	return `${value.toFixed(unitIndex === 0 ? 0 : 2)} ${units[unitIndex]}`;
}

function stripExt(filename: string): string {
	const lastDot = filename.lastIndexOf('.');
	return lastDot > 0 ? filename.slice(0, lastDot) : filename;
}

function withExt(filename: string, ext: string): string {
	return `${stripExt(filename)}.${ext}`;
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
	return new Promise((resolve, reject) => {
		canvas.toBlob(
			(blob) => {
				if (!blob) reject(new Error(`このブラウザは ${type} への変換に対応していません。`));
				else resolve(blob);
			},
			type,
			quality
		);
	});
}

let avifWorker: Worker | null = null;
let avifReqId = 0;
const avifPending = new Map<number, { resolve: (v: ArrayBuffer) => void; reject: (e: Error) => void }>();

function getAvifWorker(): Worker {
	if (avifWorker) return avifWorker;
	avifWorker = new Worker(new URL('../workers/avif-encoder.worker.ts', import.meta.url), { type: 'module' });
	avifWorker.addEventListener('message', (ev: MessageEvent<AvifEncodeResponse>) => {
		const msg = ev.data;
		if (!msg || msg.type !== 'encode-avif-result') return;
		const pending = avifPending.get(msg.id);
		if (!pending) return;
		avifPending.delete(msg.id);
		if (msg.ok) pending.resolve(msg.bytes);
		else pending.reject(new Error(msg.error));
	});
	avifWorker.addEventListener('error', (ev) => {
		console.error(ev);
	});
	return avifWorker;
}

async function encodeAvifInWorker(imageData: ImageData, quality01: number): Promise<Blob> {
	const worker = getAvifWorker();
	const id = ++avifReqId;
	const rgbaCopy = imageData.data.slice().buffer;

	const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
		avifPending.set(id, { resolve, reject });
		const msg: AvifEncodeRequest = {
			type: 'encode-avif',
			id,
			width: imageData.width,
			height: imageData.height,
			rgba: rgbaCopy,
			quality: quality01,
		};
		worker.postMessage(msg, { transfer: [rgbaCopy] });
	});

	return new Blob([bytes], { type: 'image/avif' });
}

function setText(el: Element, text: string) {
	el.textContent = text;
}

async function saveBlob(blob: Blob, filename: string) {
	const w = window as unknown as {
		showSaveFilePicker?: (opts: {
			suggestedName?: string;
			types?: Array<{ description?: string; accept: Record<string, string[]> }>;
		}) => Promise<FileSystemFileHandle>;
	};

	// Prefer the File System Access API when available: avoids "new tab" behavior on some browsers.
	if (typeof w.showSaveFilePicker === 'function') {
		const handle = await w.showSaveFilePicker({
			suggestedName: filename,
			types: [
				{
					description: 'Image',
					accept: { [blob.type || 'application/octet-stream']: [`.${filename.split('.').pop() ?? ''}`] },
				},
			],
		});
		const writable = await handle.createWritable();
		await writable.write(blob);
		await writable.close();
		return;
	}

	// Fallback: anchor download. Use an octet-stream URL to reduce cases where the browser tries to "open" the image.
	const forceDownloadBlob =
		blob.type.startsWith('image/') || blob.type === 'application/zip'
			? new Blob([blob], { type: 'application/octet-stream' })
			: blob;
	const url = URL.createObjectURL(forceDownloadBlob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	a.rel = 'noopener';
	a.target = '_self';
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 0);
}

function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (let i = 0; i < bytes.length; i++) {
		crc ^= bytes[i];
		for (let j = 0; j < 8; j++) {
			const mask = -(crc & 1);
			crc = (crc >>> 1) ^ (0xedb88320 & mask);
		}
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function u16(n: number): Uint8Array {
	const b = new Uint8Array(2);
	b[0] = n & 0xff;
	b[1] = (n >>> 8) & 0xff;
	return b;
}

function u32(n: number): Uint8Array {
	const b = new Uint8Array(4);
	b[0] = n & 0xff;
	b[1] = (n >>> 8) & 0xff;
	b[2] = (n >>> 16) & 0xff;
	b[3] = (n >>> 24) & 0xff;
	return b;
}

function concat(chunks: Uint8Array[]): Uint8Array {
	let total = 0;
	for (const c of chunks) total += c.length;
	const out = new Uint8Array(total);
	let off = 0;
	for (const c of chunks) {
		out.set(c, off);
		off += c.length;
	}
	return out;
}

async function buildZip(entries: Array<{ name: string; blob: Blob }>): Promise<Blob> {
	const encoder = new TextEncoder();
	const localParts: Uint8Array[] = [];
	const centralParts: Uint8Array[] = [];
	let offset = 0;

	for (const entry of entries) {
		const nameBytes = encoder.encode(entry.name);
		const dataBytes = new Uint8Array(await entry.blob.arrayBuffer());
		const crc = crc32(dataBytes);
		const size = dataBytes.byteLength;
		const flags = 1 << 11; // UTF-8

		// Local file header
		const localHeader = concat([
			u32(0x04034b50),
			u16(20),
			u16(flags),
			u16(0), // store
			u16(0),
			u16(0),
			u32(crc),
			u32(size),
			u32(size),
			u16(nameBytes.length),
			u16(0),
			nameBytes,
		]);
		localParts.push(localHeader, dataBytes);

		// Central directory header
		const centralHeader = concat([
			u32(0x02014b50),
			u16(20),
			u16(20),
			u16(flags),
			u16(0),
			u16(0),
			u16(0),
			u32(crc),
			u32(size),
			u32(size),
			u16(nameBytes.length),
			u16(0),
			u16(0),
			u16(0),
			u16(0),
			u32(0),
			u32(offset),
			nameBytes,
		]);
		centralParts.push(centralHeader);

		offset += localHeader.length + dataBytes.length;
	}

	const centralDir = concat(centralParts);
	const centralOffset = offset;
	const centralSize = centralDir.length;
	const count = entries.length;

	const end = concat([
		u32(0x06054b50),
		u16(0),
		u16(0),
		u16(count),
		u16(count),
		u32(centralSize),
		u32(centralOffset),
		u16(0),
	]);

	const zipBytes = concat([...localParts, centralDir, end]);
	return new Blob([zipBytes], { type: 'application/zip' });
}

function main() {
	const dropzone = assertEl(document.querySelector<HTMLDivElement>('#dropzone'), '#dropzone');
	const pickBtn = assertEl(document.querySelector<HTMLButtonElement>('#pickBtn'), '#pickBtn');
	const fileInput = assertEl(document.querySelector<HTMLInputElement>('#fileInput'), '#fileInput');
	const fileMeta = assertEl(document.querySelector<HTMLDivElement>('#fileMeta'), '#fileMeta');
	const formatSelect = assertEl(document.querySelector<HTMLSelectElement>('#formatSelect'), '#formatSelect');
	const qualitySlider = assertEl(document.querySelector<HTMLInputElement>('#qualitySlider'), '#qualitySlider');
	const qualityValue = assertEl(document.querySelector<HTMLSpanElement>('#qualityValue'), '#qualityValue');
	const convertBtn = assertEl(document.querySelector<HTMLButtonElement>('#convertBtn'), '#convertBtn');
	const downloadAllBtn = assertEl(document.querySelector<HTMLButtonElement>('#downloadAllBtn'), '#downloadAllBtn');
	const clearBtn = assertEl(document.querySelector<HTMLButtonElement>('#clearBtn'), '#clearBtn');
	const fileList = assertEl(document.querySelector<HTMLDivElement>('#fileList'), '#fileList');
	const statusEl = assertEl(document.querySelector<HTMLDivElement>('#status'), '#status');
	const errorEl = assertEl(document.querySelector<HTMLDivElement>('#error'), '#error');

	let items: Item[] = [];
	let nextItemId = 0;
	let isBusy = false;

	function setBusy(next: boolean) {
		isBusy = next;
		convertBtn.disabled = next || items.length === 0;
		clearBtn.disabled = next || items.length === 0;
		downloadAllBtn.disabled = next || items.every((it) => !it.outputBlob);
		pickBtn.disabled = next;
		fileInput.disabled = next;
		formatSelect.disabled = next;
		qualitySlider.disabled = next;
		if (next) setText(statusEl, '変換中');
		// The per-item buttons are rendered dynamically; re-render when busy state changes
		// so "ダウンロード" becomes clickable after conversion completes.
		render();
	}

	function clearError() {
		setText(errorEl, '');
	}

	function setError(message: string) {
		setText(errorEl, message);
	}

	function clearOutputs() {
		for (const item of items) {
			item.outputBlob = null;
			item.outputMime = null;
			item.outputSize = null;
			item.error = null;
			item.status = 'ready';
		}
		render();
	}

	function clearAll() {
		for (const item of items) {
			URL.revokeObjectURL(item.inputUrl);
		}
		items = [];
		render();
	}

	function totalBytes(): number {
		return items.reduce((sum, it) => sum + (it.file.size || 0), 0);
	}

	function updateMeta() {
		if (isBusy) return;
		if (items.length === 0) {
			setText(fileMeta, '');
			setText(statusEl, '');
			return;
		}
		setText(fileMeta, `${items.length}枚`);
		setText(statusEl, '');
	}

	function render() {
		updateMeta();
		convertBtn.disabled = isBusy || items.length === 0;
		clearBtn.disabled = isBusy || items.length === 0;
		downloadAllBtn.disabled = isBusy || items.every((it) => !it.outputBlob);

		fileList.replaceChildren();
		for (const item of items) {
			const row = document.createElement('div');
			row.className = 'border border-[var(--border)] rounded-lg p-4';

			const container = document.createElement('div');
			container.className = 'flex gap-4';

			const thumb = document.createElement('div');
			thumb.className = 'w-24 h-24 rounded border border-[var(--border)] overflow-hidden shrink-0 bg-[var(--bg)] relative';
			const img = document.createElement('img');
			img.alt = item.file.name;
			img.src = item.inputUrl;
			img.className = 'w-full h-full object-cover';
			thumb.appendChild(img);

			// Status icon overlay
			const statusIcon = document.createElement('div');
			statusIcon.className = 'absolute inset-0 flex items-center justify-center bg-black bg-opacity-50';
			if (item.status === 'converting') {
				statusIcon.innerHTML = '<svg class="w-8 h-8 text-white animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>';
				thumb.appendChild(statusIcon);
			} else if (item.status === 'done') {
				statusIcon.innerHTML = '<svg class="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" /></svg>';
				thumb.appendChild(statusIcon);
			} else if (item.status === 'error') {
				statusIcon.innerHTML = '<svg class="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" /></svg>';
				thumb.appendChild(statusIcon);
			}

			const content = document.createElement('div');
			content.className = 'flex-1 min-w-0 flex flex-col justify-between';

			const info = document.createElement('div');

			const nameRow = document.createElement('div');
			nameRow.className = 'flex items-center gap-2 mb-2';

			const name = document.createElement('div');
			name.className = 'text-sm text-[var(--text)] truncate flex-1';
			name.textContent = item.file.name;

			// Status badge
			const badge = document.createElement('div');
			badge.className = 'shrink-0 px-2 py-0.5 rounded text-xs';
			if (item.status === 'converting') {
				badge.className += ' bg-blue-100 text-blue-700';
				badge.textContent = '変換中';
			} else if (item.status === 'done') {
				badge.className += ' bg-green-100 text-green-700';
				badge.textContent = '完了';
			} else if (item.status === 'error') {
				badge.className += ' bg-red-100 text-red-700';
				badge.textContent = 'エラー';
			} else {
				badge.className += ' bg-gray-100 text-gray-700';
				badge.textContent = '待機中';
			}

			nameRow.appendChild(name);
			nameRow.appendChild(badge);

			const sub = document.createElement('div');
			sub.className = 'text-sm text-[var(--muted)] mb-2';
			if (item.status === 'done') {
				sub.textContent = `${formatBytes(item.file.size)} → ${formatBytes(item.outputSize ?? 0)}`;
			} else {
				sub.textContent = formatBytes(item.file.size);
			}

			// Progress bar for done items
			if (item.status === 'done' && item.outputSize) {
				const progressContainer = document.createElement('div');
				progressContainer.className = 'w-full bg-gray-200 rounded-full h-1.5 mb-2';
				const progressBar = document.createElement('div');
				const reduction = Math.max(0, Math.min(100, ((item.file.size - item.outputSize) / item.file.size) * 100));
				progressBar.className = 'bg-green-600 h-1.5 rounded-full transition-all duration-300';
				progressBar.style.width = `${reduction}%`;
				progressContainer.appendChild(progressBar);
				
				const reductionText = document.createElement('div');
				reductionText.className = 'text-xs text-green-600 mt-1';
				reductionText.textContent = `${reduction.toFixed(0)}% 削減`;
				
				info.appendChild(nameRow);
				info.appendChild(sub);
				info.appendChild(progressContainer);
				info.appendChild(reductionText);
			} else {
				info.appendChild(nameRow);
				info.appendChild(sub);
			}

			const actions = document.createElement('div');
			actions.className = 'flex gap-2 mt-3';

			const convertOneBtn = document.createElement('button');
			convertOneBtn.type = 'button';
			convertOneBtn.className = 'flex items-center gap-1.5 border border-[var(--border)] px-4 py-1.5 rounded text-sm hover:enabled:border-[var(--text)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors';
			convertOneBtn.innerHTML = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg><span>変換</span>';
			convertOneBtn.disabled = isBusy;
			convertOneBtn.addEventListener('click', () => void convertOne(item.id));

			const dlBtn = document.createElement('button');
			dlBtn.type = 'button';
			dlBtn.className = 'flex items-center gap-1.5 border border-[var(--border)] px-4 py-1.5 rounded text-sm hover:enabled:border-[var(--text)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors';
			dlBtn.innerHTML = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg><span>ダウンロード</span>';
			dlBtn.disabled = isBusy || !item.outputBlob;
			dlBtn.addEventListener('click', () => void download(item.id));

			actions.appendChild(convertOneBtn);
			actions.appendChild(dlBtn);

			content.appendChild(info);
			content.appendChild(actions);

			container.appendChild(thumb);
			container.appendChild(content);

			row.appendChild(container);
			fileList.appendChild(row);
		}
	}

	function addFiles(files: File[]) {
		clearError();
		const accepted: File[] = [];
		const rejected: File[] = [];

		for (const f of files) {
			if (['image/jpeg', 'image/png'].includes(f.type)) accepted.push(f);
			else rejected.push(f);
		}

		if (rejected.length > 0) {
			setError('JPG または PNG のみ対応しています。');
		}

		for (const file of accepted) {
			const inputUrl = URL.createObjectURL(file);
			items.push({
				id: ++nextItemId,
				file,
				inputUrl,
				status: 'ready',
				outputBlob: null,
				outputMime: null,
				outputSize: null,
				error: null,
			});
		}

		render();
	}

	async function decodeToImageData(file: File): Promise<ImageData> {
		const bitmap = await createImageBitmap(file);
		const canvas = document.createElement('canvas');
		canvas.width = bitmap.width;
		canvas.height = bitmap.height;
		const ctx = canvas.getContext('2d', { willReadFrequently: true });
		if (!ctx) throw new Error('Canvas 2D コンテキストを作成できませんでした。');
		ctx.drawImage(bitmap, 0, 0);
		bitmap.close();
		return ctx.getImageData(0, 0, canvas.width, canvas.height);
	}

	async function convertOne(itemId: number) {
		if (isBusy) return;
		const item = items.find((x) => x.id === itemId);
		if (!item) return;
		clearError();
		setBusy(true);

		try {
			const format = formatSelect.value as OutputFormat;
			const quality01 = Number(qualitySlider.value) / 100;
			item.status = 'converting';
			item.error = null;
			render();

			const imageData = await decodeToImageData(item.file);

			let blob: Blob;

			if (format === 'webp') {
				const canvas = document.createElement('canvas');
				canvas.width = imageData.width;
				canvas.height = imageData.height;
				const ctx = canvas.getContext('2d');
				if (!ctx) throw new Error('Canvas 2D コンテキストを作成できませんでした。');
				ctx.putImageData(imageData, 0, 0);
				blob = await canvasToBlob(canvas, 'image/webp', quality01);
			} else {
				blob = await encodeAvifInWorker(imageData, quality01);
			}

			item.outputBlob = blob;
			item.outputMime = blob.type || (format === 'webp' ? 'image/webp' : 'image/avif');
			item.outputSize = blob.size;
			item.status = 'done';
			render();
		} catch (err) {
			console.error(err);
			item.status = 'error';
			item.error = err instanceof Error ? err.message : String(err);
			render();
		} finally {
			setBusy(false);
		}
	}

	async function convertAll() {
		if (isBusy || items.length === 0) return;
		clearError();
		setBusy(true);

		try {
			for (const item of items) {
				// Skip already done items if settings haven't changed (we clear outputs on settings change)
				if (item.status === 'done' && item.outputBlob) continue;
				await convertOneInternal(item);
			}
		} finally {
			setBusy(false);
			render();
		}
	}

	async function convertOneInternal(item: Item) {
		const format = formatSelect.value as OutputFormat;
		const quality01 = Number(qualitySlider.value) / 100;
		item.status = 'converting';
		item.error = null;
		render();

		try {
			const imageData = await decodeToImageData(item.file);
			let blob: Blob;
			if (format === 'webp') {
				const canvas = document.createElement('canvas');
				canvas.width = imageData.width;
				canvas.height = imageData.height;
				const ctx = canvas.getContext('2d');
				if (!ctx) throw new Error('Canvas 2D コンテキストを作成できませんでした。');
				ctx.putImageData(imageData, 0, 0);
				blob = await canvasToBlob(canvas, 'image/webp', quality01);
			} else {
				blob = await encodeAvifInWorker(imageData, quality01);
			}

			item.outputBlob = blob;
			item.outputMime = blob.type || (format === 'webp' ? 'image/webp' : 'image/avif');
			item.outputSize = blob.size;
			item.status = 'done';
			item.error = null;
			render();
		} catch (err) {
			console.error(err);
			item.status = 'error';
			item.error = err instanceof Error ? err.message : String(err);
			render();
		}
	}

	async function download(itemId: number) {
		const item = items.find((x) => x.id === itemId);
		if (!item?.outputBlob) return;
		const format = formatSelect.value as OutputFormat;
		const outputFilename = withExt(item.file.name, format === 'webp' ? 'webp' : 'avif');
		await saveBlob(item.outputBlob, outputFilename);
	}

	async function downloadAllAsZip() {
		if (isBusy) return;
		const done = items.filter((it) => it.outputBlob);
		if (done.length === 0) return;

		clearError();
		setBusy(true);
		try {
			const format = formatSelect.value as OutputFormat;
			const zipEntries = done.map((it) => ({
				name: withExt(it.file.name, format === 'webp' ? 'webp' : 'avif'),
				blob: it.outputBlob!,
			}));
			const zipBlob = await buildZip(zipEntries);
			const ts = new Date();
			const stamp = `${ts.getFullYear()}${String(ts.getMonth() + 1).padStart(2, '0')}${String(ts.getDate()).padStart(2, '0')}-${String(
				ts.getHours()
			).padStart(2, '0')}${String(ts.getMinutes()).padStart(2, '0')}${String(ts.getSeconds()).padStart(2, '0')}`;
			await saveBlob(zipBlob, `converted-${stamp}.zip`);
		} catch (err) {
			console.error(err);
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}

	function openPicker() {
		if (isBusy) return;
		fileInput.click();
	}

	function handleFiles(files: FileList | null) {
		if (!files || files.length === 0) return;
		addFiles(Array.from(files));
		fileInput.value = '';
	}

	qualitySlider.addEventListener('input', () => {
		setText(qualityValue, String(qualitySlider.value));
		clearOutputs();
	});

	formatSelect.addEventListener('change', () => {
		clearOutputs();
	});

	convertBtn.addEventListener('click', () => {
		void convertAll();
	});
	downloadAllBtn.addEventListener('click', () => {
		void downloadAllAsZip();
	});

	pickBtn.addEventListener('click', openPicker);
	dropzone.addEventListener('click', openPicker);
	clearBtn.addEventListener('click', () => {
		if (isBusy) return;
		clearError();
		clearAll();
	});

	dropzone.addEventListener('keydown', (ev) => {
		if (ev.key === 'Enter' || ev.key === ' ') {
			ev.preventDefault();
			openPicker();
		}
	});

	fileInput.addEventListener('change', () => handleFiles(fileInput.files));

	dropzone.addEventListener('dragover', (ev) => {
		ev.preventDefault();
		dropzone.classList.add('is-dragover');
	});
	dropzone.addEventListener('dragleave', () => {
		dropzone.classList.remove('is-dragover');
	});
	dropzone.addEventListener('drop', (ev) => {
		ev.preventDefault();
		dropzone.classList.remove('is-dragover');
		handleFiles(ev.dataTransfer?.files ?? null);
	});

	window.addEventListener('beforeunload', () => {
		for (const item of items) {
			URL.revokeObjectURL(item.inputUrl);
		}
	});

	render();
}

main();
