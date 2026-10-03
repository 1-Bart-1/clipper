APP := clipper
PREFIX ?= $(HOME)/.local
SHARE := $(PREFIX)/share/$(APP)
VENV := $(SHARE)/venv
LAUNCHER := $(PREFIX)/bin/$(APP)
DESKTOP := $(PREFIX)/share/applications/$(APP).desktop
ICON := $(PREFIX)/share/icons/hicolor/scalable/apps/$(APP).svg

.PHONY: install uninstall run check

install:
	@command -v ffmpeg >/dev/null || { echo "clipper needs ffmpeg: pacman -S ffmpeg"; exit 1; }
	python3 -m venv --clear $(VENV)
	@site=$$($(VENV)/bin/python -c 'import sysconfig; print(sysconfig.get_paths()["purelib"])'); \
	 rm -rf "$$site/$(APP)" && tar -cf - --exclude=__pycache__ $(APP) | tar -xf - -C "$$site" \
	 && echo "installed package into $$site"
	@install -d $(dir $(LAUNCHER)) $(dir $(DESKTOP)) $(dir $(ICON))
	@printf '#!/bin/sh\nexec %s -m %s "$$@"\n' "$(VENV)/bin/python" "$(APP)" > $(LAUNCHER)
	@chmod +x $(LAUNCHER)
	@sed 's|@ICON@|$(APP)|' $(APP).desktop.in > $(DESKTOP)
	@cp $(APP).svg $(ICON)
	@update-desktop-database $(PREFIX)/share/applications 2>/dev/null || true
	@echo "installed $(LAUNCHER) and a launcher entry — run: $(APP) ~/Pictures/Ierland"

uninstall:
	rm -rf $(SHARE) $(LAUNCHER) $(DESKTOP) $(ICON)
	@update-desktop-database $(PREFIX)/share/applications 2>/dev/null || true
	@echo "removed clipper (your photos and clips are untouched)"

run:
	python3 -m $(APP) $(LIBRARY)

check:
	python3 -m compileall -q $(APP) && echo "syntax clean"
