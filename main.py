import customtkinter as ctk
from tkinter import filedialog
from tkinterdnd2 import DND_FILES, TkinterDnD
import os
from PIL import Image
import pillow_avif
import threading


class AVIFConverterApp(ctk.CTk, TkinterDnD.DnDWrapper):
    def __init__(self):
        super().__init__()
        self.TkdndVersion = TkinterDnD._require(self)
        
        # ウィンドウの基本設定
        self.title("AVIF Converter")
        self.geometry("600x400")
        
        # カラーテーマとアピアランスモードの設定
        ctk.set_appearance_mode("system")
        ctk.set_default_color_theme("blue")
        
        # UIの構築
        self.create_widgets()
    
    def create_widgets(self):
        """UIウィジェットの作成"""
        # メインフレーム
        self.main_frame = ctk.CTkFrame(self)
        self.main_frame.pack(fill="both", expand=True, padx=20, pady=20)
        
        # タイトルラベル
        self.title_label = ctk.CTkLabel(
            self.main_frame,
            text="AVIF Image Converter",
            font=ctk.CTkFont(size=24, weight="bold")
        )
        self.title_label.pack(pady=(10, 20))
        
        # ドラッグ&ドロップエリア
        self.drop_frame = ctk.CTkFrame(
            self.main_frame,
            width=400,
            height=100,
            border_width=2,
            border_color="gray"
        )
        self.drop_frame.pack(pady=10, padx=20, fill="x")
        
        self.drop_label = ctk.CTkLabel(
            self.drop_frame,
            text="ここに画像ファイルをドラッグ&ドロップ\nまたは下のボタンから選択",
            font=ctk.CTkFont(size=14)
        )
        self.drop_label.pack(expand=True, pady=30)
        
        # ドラッグ&ドロップの設定
        self.drop_frame.drop_target_register(DND_FILES)
        self.drop_frame.dnd_bind('<<Drop>>', self.on_drop)
        
        # ファイル選択ボタン
        self.select_files_button = ctk.CTkButton(
            self.main_frame,
            text="画像ファイルを選択",
            command=self.select_files,
            width=200,
            height=40
        )
        self.select_files_button.pack(pady=10)
        
        # 保存先選択ボタン
        self.select_output_button = ctk.CTkButton(
            self.main_frame,
            text="保存先フォルダを選択",
            command=self.select_output_folder,
            width=200,
            height=40
        )
        self.select_output_button.pack(pady=10)
        
        # 選択されたファイル数の表示
        self.file_count_label = ctk.CTkLabel(
            self.main_frame,
            text="選択されたファイル: 0",
            font=ctk.CTkFont(size=12)
        )
        self.file_count_label.pack(pady=10)
        
        # 保存先パスの表示
        self.output_path_label = ctk.CTkLabel(
            self.main_frame,
            text="保存先: 未設定",
            font=ctk.CTkFont(size=12)
        )
        self.output_path_label.pack(pady=5)
        
        # 変換ボタン
        self.convert_button = ctk.CTkButton(
            self.main_frame,
            text="AVIF形式に変換",
            command=self.start_conversion,
            width=200,
            height=40,
            state="disabled"
        )
        self.convert_button.pack(pady=20)
        
        # プログレスバー
        self.progress_bar = ctk.CTkProgressBar(
            self.main_frame,
            width=400
        )
        self.progress_bar.pack(pady=10)
        self.progress_bar.set(0)
        self.progress_bar.pack_forget()  # 初期状態では非表示
        
        # ステータスラベル
        self.status_label = ctk.CTkLabel(
            self.main_frame,
            text="",
            font=ctk.CTkFont(size=12)
        )
        self.status_label.pack(pady=10)
        
        # 変数の初期化
        self.selected_files = []
        self.output_folder = ""
        self.supported_formats = ('.jpg', '.jpeg', '.png', '.bmp', '.gif', '.tiff', '.tif', '.webp')
        self.is_converting = False
    
    def select_files(self):
        """画像ファイルの選択"""
        filetypes = [
            ("画像ファイル", "*.jpg *.jpeg *.png *.bmp *.gif *.tiff *.webp"),
            ("すべてのファイル", "*.*")
        ]
        files = filedialog.askopenfilenames(
            title="変換する画像を選択",
            filetypes=filetypes
        )
        
        if files:
            self.selected_files = list(files)
            self.file_count_label.configure(
                text=f"選択されたファイル: {len(self.selected_files)}"
            )
            self.update_convert_button_state()
    
    def select_output_folder(self):
        """保存先フォルダの選択"""
        folder = filedialog.askdirectory(title="保存先フォルダを選択")
        
        if folder:
            self.output_folder = folder
            # パスが長い場合は省略表示
            display_path = folder if len(folder) < 50 else "..." + folder[-47:]
            self.output_path_label.configure(
                text=f"保存先: {display_path}"
            )
            self.update_convert_button_state()
    
    def update_convert_button_state(self):
        """変換ボタンの有効/無効を更新"""
        if self.selected_files and self.output_folder:
            self.convert_button.configure(state="normal")
        else:
            self.convert_button.configure(state="disabled")
    
    def on_drop(self, event):
        """ドラッグ&ドロップされたファイルを処理"""
        # ドロップされたファイルパスを取得（波括弧で囲まれている場合があるため処理）
        files = self.tk.splitlist(event.data)
        
        # 画像ファイルのみをフィルタリング
        image_files = []
        for file in files:
            # 波括弧を除去
            file = file.strip('{}').strip()
            if os.path.isfile(file) and file.lower().endswith(self.supported_formats):
                image_files.append(file)
        
        if image_files:
            self.selected_files = image_files
            self.file_count_label.configure(
                text=f"選択されたファイル: {len(self.selected_files)}"
            )
            self.update_convert_button_state()
            self.status_label.configure(
                text=f"{len(image_files)}個の画像ファイルを受け取りました",
                text_color="green"
            )
        else:
            self.status_label.configure(
                text="対応していないファイル形式です",
                text_color="red"
            )
    
    def start_conversion(self):
        """変換を開始（スレッドで実行）"""
        if self.is_converting:
            return
        
        self.is_converting = True
        self.convert_button.configure(state="disabled", text="変換中...")
        self.progress_bar.pack(pady=10)
        self.progress_bar.set(0)
        
        # 別スレッドで変換実行
        thread = threading.Thread(target=self.convert_images, daemon=True)
        thread.start()
    
    def convert_images(self):
        """画像をAVIF形式に変換（スレッド内で実行）"""
        if not self.selected_files or not self.output_folder:
            return
        
        total = len(self.selected_files)
        success_count = 0
        error_count = 0
        
        for i, input_path in enumerate(self.selected_files, 1):
            try:
                # ファイル名を取得して拡張子を.avifに変更
                filename = os.path.splitext(os.path.basename(input_path))[0]
                output_path = os.path.join(self.output_folder, f"{filename}.avif")
                
                # 画像を開いて変換
                with Image.open(input_path) as img:
                    # RGBAモードの場合はRGBに変換（AVIFは透明度をサポートしますが、互換性のため）
                    if img.mode in ('RGBA', 'LA', 'P'):
                        # 透明度を持つ画像はそのまま保存
                        if img.mode == 'P':
                            img = img.convert('RGBA')
                    elif img.mode != 'RGB':
                        img = img.convert('RGB')
                    
                    # AVIF形式で保存（高品質設定）
                    img.save(output_path, 'AVIF', quality=85)
                
                success_count += 1
                progress = i / total
                
                # UI更新はafterを使ってメインスレッドで実行
                self.after(0, self.update_progress, progress, i, total)
                
            except Exception as e:
                error_count += 1
                print(f"エラー: {input_path} - {str(e)}")
        
        # 完了処理
        self.after(0, self.conversion_complete, success_count, error_count, total)
    
    def update_progress(self, progress, current, total):
        """進行状況を更新（メインスレッドで実行）"""
        self.progress_bar.set(progress)
        self.status_label.configure(
            text=f"変換中... {current}/{total}",
            text_color="blue"
        )
    
    def conversion_complete(self, success_count, error_count, total):
        """変換完了処理（メインスレッドで実行）"""
        self.is_converting = False
        self.convert_button.configure(state="normal", text="AVIF形式に変換")
        self.progress_bar.set(1.0)
        
        # 完了メッセージ
        if error_count == 0:
            self.status_label.configure(
                text=f"変換完了！ {success_count}個のファイルを変換しました",
                text_color="green"
            )
        else:
            self.status_label.configure(
                text=f"変換完了: 成功 {success_count}個, 失敗 {error_count}個",
                text_color="orange"
            )


def main():
    app = AVIFConverterApp()
    app.mainloop()


if __name__ == "__main__":
    main()
