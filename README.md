# Sinus 3D Viewer Pro 🔬

Modular DICOM CBCT / CT visualization and multi-planar reconstruction (MPR) web platform.

## 🚀 Features

- **Multi-Planar Reconstruction (MPR)**: Axial, Coronal, and Sagittal viewports with synchronous crosshairs.
- **3D Volume Rendering**: High-performance CT/CBCT volume visualization.
- **Interactive Measurement Tools**: Length, angle, ROI, window/level (HU) presets for sinus and bone pathology.
- **FastAPI Backend**: Asynchronous DICOM parsing, volume streaming, caching, and preprocessing.
- **Modern React & Cornerstone3D Frontend**: Clean UI powered by TypeScript, TailwindCSS, and Cornerstone3D.

## 📁 Project Structure

```
├── sinus-viewer/
│   ├── backend/         # FastAPI backend (DICOM engine, volume services, API)
│   ├── frontend/        # React + TypeScript + Cornerstone3D web viewer
│   ├── launcher/        # Bootstrap & server launcher utilities
│   ├── config/          # Environment configuration
│   ├── scripts/         # Build & validation automation scripts
│   └── tests/           # Backend & frontend test suites
├── imp_file.ipynb       # Supplementary analysis notebook
├── run_code.ipynb       # Workflow execution notebook
├── sinus_viewer.ipynb   # Interactive sinus viewer notebook
└── README.md
```

## 🛠️ Quick Start

### 1. Backend Setup

```bash
cd sinus-viewer
python -m venv .venv
# Activate virtual environment
# Windows:
.venv\Scripts\activate
# Linux/macOS:
source .venv/bin/activate

pip install -r backend/requirements.txt
```

Run backend server:
```bash
python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

### 2. Frontend Setup

```bash
cd sinus-viewer/frontend
npm install
npm run dev
```

Navigate to `http://localhost:5173` to access the Sinus 3D Viewer Pro interface.

## 📄 License

MIT License.
