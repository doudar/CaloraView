"""Convert the original Skarix MCP PNG into desktop icon formats."""
from pathlib import Path
from PIL import Image

root = Path(__file__).resolve().parent.parent
brand = root / "assets" / "brand"
source = Image.open(brand / "skarix-icon.png").convert("RGBA")
icon = source.resize((1024, 1024), Image.Resampling.LANCZOS)
icon.save(brand / "icon.png")
icon.save(brand / "icon.ico", sizes=[(n, n) for n in (16, 24, 32, 48, 64, 128, 256)])
icon.save(brand / "icon.icns")
renderer = root / "src" / "renderer" / "assets"
renderer.mkdir(exist_ok=True)
icon.resize((128, 128), Image.Resampling.LANCZOS).save(renderer / "icon.png")
print("Converted Skarix artwork to PNG, Windows ICO, macOS ICNS and renderer PNG.")
