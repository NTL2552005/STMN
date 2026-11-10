
from pathlib import Path
import subprocess
import sys

BASE_DIR = Path(__file__).resolve().parent
APPS_DIR = BASE_DIR / "apps"

modules = [
    "accounts",
    "catalog",
    "suppliers",
    "purchasing",
    "inventory",
    "customers",
    "shifts",
    "sales",
    "payments",
    "accounting",
    "reports",
]

APPS_DIR.mkdir(exist_ok=True)
(APPS_DIR / "__init__.py").touch()

for name in modules:
    path = APPS_DIR / name
    path.mkdir(exist_ok=True)

    config_file = path / "apps.py"

    if not config_file.exists():
        subprocess.run(
            [
                sys.executable,
                str(BASE_DIR / "manage.py"),
                "startapp",
                name,
                str(path),
            ],
            cwd=BASE_DIR,
            check=True,
        )

    content = config_file.read_text(encoding="utf-8")
    content = content.replace(
        f"name = '{name}'",
        f"name = 'apps.{name}'",
    )
    config_file.write_text(content, encoding="utf-8")

    print(f"OK: {name}")

print("Da tao xong cac Django apps!")
