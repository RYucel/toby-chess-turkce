# Toby Satranç (PWA)

**[Toby 2 — The Oracle By Yosha](https://github.com/Yosha87/Toby)** motoruyla çalışan, telefona kurulabilir (PWA) Türkçe satranç uygulaması.

## Özellikler

- **Toby 2 ile İnsan Gibi Oyna**: 800–2900 ELO arası, Klasik / Hızlı / Yıldırım ve FIDE / Lichess / Chess.com ayarlarıyla gerçek insan hamle olasılıklarından örnekleyerek oynar.
- **Toby Oyun İnceleme (Performans ELO & Hamle Tahmini)**:
  - Oynanan herhangi bir PGN (veya uygulama içinde oynadığınız oyun) için Beyaz ve Siyah'ın **Toby Performans ELO** tahminini hesaplar.
  - Toby'nin oyundaki toplam kaç hamleyi doğru tahmin ettiğini (örn. `55/76 (%72)`) ve her iki oyuncu için ayrı ayrı tahmin oranını gösterir.
  - Oynanan hamlelere ortalama yüzde kaç olasılık verdiğini hesaplar ve her hamle için Toby'nin en olası tahminlerini etkileşimli tahta ve grafik üzerinde gösterir.
- **Canlı Oracle Analiz Tahtası**: İstediğiniz konumda ELO seviyesini değiştirerek 1200 ile 2800 oyuncuların hamle olasılıkları (`N%`, `P%`) ve Kazanma / Beraberlik / Kayıp (`WDL`) oranlarının nasıl değiştiğini oklarla tahta üzerinde görün.
- **Telefona Kurulabilir PWA**: Android (Chrome/Edge) ve iOS (Safari → Paylaş → Ana Ekrana Ekle) ile tam ekran uygulama olarak kurulabilir.

## Mimari

Toby 2 (PyTorch sinir ağı + Stockfish 19, ~690 MB) tarayıcı içinde doğrudan çalışamayacağı için uygulama iki parçadan oluşur:
- `backend/`: Resmi **Toby 2** UCI motorunu çalıştıran FastAPI sunucusu (aynı zamanda derlenmiş PWA arayüzünü sunar).
- `frontend/`: Vite + `chess.js` tabanlı mobil öncelikli PWA arayüzü.

## Kurulum ve Çalıştırma

### 1. Toby 2 Motorunu İndirin
```bash
./scripts/install_toby.sh
```
*(Varsayılan olarak `~/toby-engine/Toby/toby` konumuna indirir. Farklı bir yol kullanmak için `TOBY_BIN=/yol/toby` ortam değişkenini ayarlayabilirsiniz.)*

### 2. Backend Bağımlılıklarını Kurun
```bash
pip install -r backend/requirements.txt
```

### 3. Frontend'i Derleyin
```bash
cd frontend
npm install
npm run build
cd ..
```

### 4. Sunucuyu Başlatın
```bash
python3 backend/app.py
```
Varsayılan olarak `http://0.0.0.0:8080` üzerinde çalışır.

## Windows Çalıştırılabilir Dosya (`TobySatranc.exe`)

- **Hazır `.exe` İndirme**: GitHub deposundaki **Actions → Build Windows Executable (TobySatranc.exe)** sekmesinden `TobySatranc-Windows.zip` dosyasını indirebilirsiniz.
- **Tek Tıkla Başlatma**: `TobySatranc.exe` ilk çalıştırmada yanında `Toby\toby.exe` yoksa resmi **Toby 2.0 Windows Light** motorunu otomatik indirir, yerel sunucuyu başlatır, tarayıcıyı açar ve telefonunuzdan bağlanmanız için yerel Wi-Fi IP adresinizi (`http://192.168.x.x:8080`) ekranda gösterir.
- **Kendiniz Derlemek İsterseniz (Windows PowerShell)**:
  ```powershell
  .\scripts\build_windows.ps1
  ```

## Telefona Nasıl Kurulur?

1. Windows'ta `TobySatranc.exe`'yi çift tıklayın (veya Linux/macOS'ta `python3 backend/app.py` çalıştırın).
2. Telefonunuzla aynı Wi-Fi ağındaysanız terminalde gösterilen `http://<BILGISAYAR_IP>:8080` adresini (veya HTTPS PWA kurulumu için Cloudflare Tunnel / Tailscale HTTPS adresinizi) telefon tarayıcısında açın.
3. **Android (Chrome)**: Menü → *"Uygulamayı yükle"* / *"Ana ekrana ekle"*.
4. **iPhone (Safari)**: Paylaş simgesi → *"Ana Ekrana Ekle"*.

## Lisans

Bu proje [Toby (AGPL v3)](https://github.com/Yosha87/Toby) motoru ile çalışır.
