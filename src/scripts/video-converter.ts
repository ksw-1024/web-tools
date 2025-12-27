import { FFmpeg, FFFSType } from '@ffmpeg/ffmpeg';
import coreURL from '@ffmpeg/core?url';
import wasmURL from '@ffmpeg/core/wasm?url';

type OutputFormat = 'mp4' | 'webm';

type ItemStatus = 'ready' | 'converting' | 'done' | 'error';

type Item = {
	id: number;
	file: File;
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

function setText(el: Element, text: string) {
	el.textContent = text;
}

async function readVideoMetadata(file: File): Promise<{ width: number; height: number }> {
	return await new Promise((resolve, reject) => {
		const video = document.createElement('video');
		video.preload = 'metadata';
		const url = URL.createObjectURL(file);
		const cleanup = () => {
			URL.revokeObjectURL(url);
			video.removeAttribute('src');
			video.load();
		};
		video.onloadedmetadata = () => {
			const width = video.videoWidth || 0;
			const height = video.videoHeight || 0;
			cleanup();
			resolve({ width, height });
		};
		video.onerror = () => {
			cleanup();
			reject(new Error('Failed to read metadata'));
		};
		video.src = url;
	});
}

async function saveBlob(blob: Blob, filename: string) {
	const w = window as unknown as {
		showSaveFilePicker?: (opts: {
			suggestedName?: string;
			types?: Array<{ description?: string; accept: Record<string, string[]> }>;
		}) => Promise<FileSystemFileHandle>;
	};

	if (typeof w.showSaveFilePicker === 'function') {
		const handle = await w.showSaveFilePicker({
			suggestedName: filename,
			types: [
				{
					description: 'Video',
					accept: { [blob.type || 'application/octet-stream']: [`.${filename.split('.').pop() ?? ''}`] },
				},
			],
		});
		const writable = await handle.createWritable();
		await writable.write(blob);
		await writable.close();
		return;
	}

	const forceDownloadBlob = blob.type.startsWith('video/')
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

function main() {
	const dropzone = assertEl(document.querySelector<HTMLDivElement>('#dropzone'), '#dropzone');
	const pickBtn = assertEl(document.querySelector<HTMLButtonElement>('#pickBtn'), '#pickBtn');
	const fileInput = assertEl(document.querySelector<HTMLInputElement>('#fileInput'), '#fileInput');
	const fileMeta = assertEl(document.querySelector<HTMLDivElement>('#fileMeta'), '#fileMeta');
	const sizeSelect = assertEl(document.querySelector<HTMLSelectElement>('#sizeSelect'), '#sizeSelect');
	const formatSelect = assertEl(document.querySelector<HTMLSelectElement>('#formatSelect'), '#formatSelect');
	const convertBtn = assertEl(document.querySelector<HTMLButtonElement>('#convertBtn'), '#convertBtn');
	const clearBtn = assertEl(document.querySelector<HTMLButtonElement>('#clearBtn'), '#clearBtn');
	const progressWrap = assertEl(document.querySelector<HTMLDivElement>('#progressWrap'), '#progressWrap');
	const progressBar = assertEl(document.querySelector<HTMLDivElement>('#progressBar'), '#progressBar');
	const progressLabel = assertEl(document.querySelector<HTMLDivElement>('#progressLabel'), '#progressLabel');
	const fileList = assertEl(document.querySelector<HTMLDivElement>('#fileList'), '#fileList');
	const statusEl = assertEl(document.querySelector<HTMLDivElement>('#status'), '#status');
	const errorEl = assertEl(document.querySelector<HTMLDivElement>('#error'), '#error');

	const ffmpeg = new FFmpeg();
	let ffmpegLoaded = false;
	let ffmpegLoading: Promise<void> | null = null;

	let items: Item[] = [];
	let nextItemId = 0;
	let isBusy = false;
	let progressActive = false;
	let activeIndex = 0;
	let activeTotal = 0;
	let activeName = '';
	let ffmpegObjectUrls: string[] = [];

	function setStatus(message: string) {
		setText(statusEl, message);
	}

	function setProgress(value: number | null) {
		if (value === null) {
			progressActive = false;
			progressWrap.classList.add('hidden');
			progressBar.style.width = '0%';
			progressLabel.textContent = '';
			return;
		}
		progressActive = true;
		const pct = Math.max(0, Math.min(100, Math.round(value * 100)));
		progressBar.style.width = `${pct}%`;
		const prefix = activeTotal > 0 ? `${activeIndex}/${activeTotal}` : '';
		const name = activeName ? ` ${activeName}` : '';
		progressLabel.textContent = `${prefix}${name} ${pct}%`;
		progressWrap.classList.remove('hidden');
	}

	function clearError() {
		setText(errorEl, '');
	}

	function setError(message: string) {
		setText(errorEl, message);
	}

	function setBusy(next: boolean) {
		isBusy = next;
		convertBtn.disabled = next || items.length === 0;
		clearBtn.disabled = next || items.length === 0;
		pickBtn.disabled = next;
		fileInput.disabled = next;
		sizeSelect.disabled = next;
		formatSelect.disabled = next;
		if (next) setStatus('変換中');
		if (!next && items.length === 0) setStatus('');
		if (!next) setProgress(null);
		render();
	}

	function updateMeta() {
		if (isBusy) return;
		if (items.length === 0) {
			setText(fileMeta, '');
			setStatus('');
			return;
		}
		setText(fileMeta, `${items.length}本`);
		setStatus('');
	}

	function clearOutputs() {
		for (const item of items) {
			item.outputBlob = null;
			item.outputMime = null;
			item.outputSize = null;
			item.status = 'ready';
			item.error = null;
		}
		render();
	}

	function clearAll() {
		items = [];
		render();
	}

	function render() {
		updateMeta();
		convertBtn.disabled = isBusy || items.length === 0;
		clearBtn.disabled = isBusy || items.length === 0;

		fileList.replaceChildren();
		for (const item of items) {
			const row = document.createElement('div');
			row.className = 'border border-[var(--border)] rounded-lg p-4';

			const container = document.createElement('div');
			container.className = 'flex gap-4';

			const icon = document.createElement('div');
			icon.className = 'w-12 h-12 rounded border border-[var(--border)] flex items-center justify-center shrink-0 text-[var(--muted)]';
			icon.innerHTML = '<svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14m-6 0h.01M4 6h9a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V8a2 2 0 012-2z" /></svg>';

			const content = document.createElement('div');
			content.className = 'flex-1 min-w-0 flex flex-col justify-between';

			const info = document.createElement('div');

			const nameRow = document.createElement('div');
			nameRow.className = 'flex items-center gap-2 mb-2';

			const name = document.createElement('div');
			name.className = 'text-sm text-[var(--text)] truncate flex-1';
			name.textContent = item.file.name;

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
			sub.className = 'text-sm text-[var(--muted)]';
			if (item.status === 'done' && item.outputSize) {
				sub.textContent = `${formatBytes(item.file.size)} → ${formatBytes(item.outputSize)}`;
			} else {
				sub.textContent = formatBytes(item.file.size);
			}

			info.appendChild(nameRow);
			info.appendChild(sub);

			if (item.status === 'error' && item.error) {
				const err = document.createElement('div');
				err.className = 'text-xs text-[var(--danger)] mt-1';
				err.textContent = item.error;
				info.appendChild(err);
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

			container.appendChild(icon);
			container.appendChild(content);

			row.appendChild(container);
			fileList.appendChild(row);
		}
	}

	function beginProgress(item: Item, index: number, total: number) {
		activeIndex = index;
		activeTotal = total;
		activeName = item.file.name;
		setProgress(0);
		setStatus(`変換中 ${index}/${total}`);
	}

	async function loadFfmpeg() {
		if (ffmpegLoaded) return;
		if (ffmpegLoading) return ffmpegLoading;
		setStatus('FFmpegを準備しています');
		ffmpegLoading = (async () => {
			// ダウンロード進捗を表示しながら core/wasm を取得してから読み込む
			const fetchWithProgress = async (url: string, label: string) => {
				const res = await fetch(url);
				if (!res.ok || !res.body) throw new Error(`Failed to fetch ${label}`);
				const contentLength = Number(res.headers.get('Content-Length') ?? 0);
				const reader = res.body.getReader();
				const chunks: BlobPart[] = [];
				let received = 0;
				activeIndex = 0;
				activeTotal = 0;
				activeName = `${label} をダウンロード中`;
				setProgress(0);

				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					if (value) {
						chunks.push(value);
						received += value.length;
						if (contentLength > 0) {
							setProgress(Math.min(0.99, received / contentLength));
						}
					}
				}

				const blob = new Blob(chunks, { type: res.headers.get('Content-Type') ?? 'application/octet-stream' });
				const objectUrl = URL.createObjectURL(blob);
				ffmpegObjectUrls.push(objectUrl);
				return objectUrl;
			};

			const coreObjectURL = await fetchWithProgress(coreURL, 'ffmpeg core');
			const wasmObjectURL = await fetchWithProgress(wasmURL, 'ffmpeg wasm');
			setStatus('FFmpegを初期化しています');
			setProgress(0.99);
			await ffmpeg.load({ coreURL: coreObjectURL, wasmURL: wasmObjectURL });
			setProgress(1);
			ffmpegLoaded = true;
		})();
		try {
			await ffmpegLoading;
			setStatus('');
		} catch (err) {
			setError('FFmpegの読み込みに失敗しました。');
			throw err;
		} finally {
			for (const url of ffmpegObjectUrls) URL.revokeObjectURL(url);
			ffmpegObjectUrls = [];
			setProgress(null);
			ffmpegLoading = null;
		}
	}

	async function mountInputFile(file: File, mountDir: string): Promise<string> {
		try {
			await ffmpeg.createDir(mountDir);
		} catch {
			// ignore mkdir errors (already exists)
		}
		await ffmpeg.mount(FFFSType.WORKERFS, { files: [file] }, mountDir);
		return `${mountDir}/${file.name}`;
	}

	async function unmountInputFile(mountDir: string) {
		try {
			await ffmpeg.unmount(mountDir);
		} catch {
			// ignore unmount errors
		}
		try {
			await ffmpeg.deleteDir(mountDir);
		} catch {
			// ignore cleanup errors
		}
	}

	function getTargetHeight(): number | null {
		if (sizeSelect.value === 'original') return null;
		const value = Number(sizeSelect.value);
		return Number.isFinite(value) && value > 0 ? value : null;
	}

	function getOutputFormat(): OutputFormat {
		return formatSelect.value as OutputFormat;
	}

	function getOutputMime(format: OutputFormat): string {
		return format === 'mp4' ? 'video/mp4' : 'video/webm';
	}

	async function convertOne(itemId: number) {
		if (isBusy) return;
		const item = items.find((x) => x.id === itemId);
		if (!item) return;
		clearError();
		setBusy(true);
		try {
			await convertOneInternal(item, 1, 1);
		} finally {
			setBusy(false);
		}
	}

	async function convertAll() {
		if (isBusy || items.length === 0) return;
		clearError();
		setBusy(true);
		try {
			const targets = items.filter((it) => !(it.status === 'done' && it.outputBlob));
			const total = targets.length;
			for (let index = 0; index < targets.length; index++) {
				const item = targets[index];
				await convertOneInternal(item, index + 1, total);
			}
		} finally {
			setBusy(false);
		}
	}

	async function convertOneInternal(item: Item, index: number, total: number) {
		await loadFfmpeg();
		const format = getOutputFormat();
		let targetHeight = getTargetHeight();
		const outputExt = format === 'mp4' ? 'mp4' : 'webm';
		const outputName = `output-${item.id}.${outputExt}`;
		const mountDir = `/input-${item.id}`;

		item.status = 'converting';
		item.error = null;
		beginProgress(item, index, total);
		render();

		try {
			if (format === 'webm' && !targetHeight) {
				try {
					const meta = await readVideoMetadata(item.file);
					if (meta.height > 720) targetHeight = 720;
				} catch {
					// ignore metadata errors and keep original size
				}
			}

			const inputPath = await mountInputFile(item.file, mountDir);
			const args: string[] = ['-i', inputPath];
			if (targetHeight) {
				args.push('-vf', `scale=-2:${targetHeight}`);
			}
			if (format === 'webm') {
				args.push(
					'-c:v',
					'libvpx',
					'-b:v',
					'1M',
					'-deadline',
					'realtime',
					'-cpu-used',
					'6',
					'-threads',
					'1',
					'-c:a',
					'libopus',
					'-b:a',
					'96k',
				);
			}
			args.push(outputName);
			await ffmpeg.exec(args);
			const data = await ffmpeg.readFile(outputName);
			const mime = getOutputMime(format);
			const blob = new Blob([data], { type: mime });

			item.outputBlob = blob;
			item.outputMime = mime;
			item.outputSize = blob.size;
			item.status = 'done';
			setProgress(1);
			render();
		} catch (err) {
			console.error(err);
			item.status = 'error';
			item.error = err instanceof Error ? err.message : String(err);
			render();
		} finally {
			try {
				await unmountInputFile(mountDir);
			} catch {
				// ignore cleanup errors
			}
			try {
				await ffmpeg.deleteFile(outputName);
			} catch {
				// ignore cleanup errors
			}
		}
	}

	async function download(itemId: number) {
		const item = items.find((x) => x.id === itemId);
		if (!item?.outputBlob) return;
		const format = getOutputFormat();
		const outputFilename = withExt(item.file.name, format === 'mp4' ? 'mp4' : 'webm');
		await saveBlob(item.outputBlob, outputFilename);
	}

	function addFiles(files: File[]) {
		clearError();
		const accepted: File[] = [];
		const rejected: File[] = [];

		for (const f of files) {
			if (f.type.startsWith('video/')) accepted.push(f);
			else rejected.push(f);
		}

		if (rejected.length > 0) {
			setError('動画ファイルのみ対応しています。');
		}

		for (const file of accepted) {
			items.push({
				id: ++nextItemId,
				file,
				status: 'ready',
				outputBlob: null,
				outputMime: null,
				outputSize: null,
				error: null,
			});
		}

		render();
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

	sizeSelect.addEventListener('change', () => {
		clearOutputs();
	});

	formatSelect.addEventListener('change', () => {
		clearOutputs();
	});

	convertBtn.addEventListener('click', () => {
		void convertAll();
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

	render();

	ffmpeg.on('progress', ({ progress }) => {
		if (!isBusy || !progressActive) return;
		if (typeof progress === 'number') setProgress(progress);
	});
}

main();
