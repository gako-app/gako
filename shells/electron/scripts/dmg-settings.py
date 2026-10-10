# Gako: a workspace app for reviewing and supervising coding agents across many repositories.
# Copyright (C) 2026 João Sena Ribeiro
#
# This program is free software: you can redistribute it and/or modify it under the terms of the
# GNU Affero General Public License as published by the Free Software Foundation, either version 3
# of the License, or (at your option) any later version.
#
# This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without
# even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
# Affero General Public License for more details.
#
# You should have received a copy of the GNU Affero General Public License along with this program.
# If not, see <https://www.gnu.org/licenses/>.

# dmgbuild's settings for Gako's disk image, run by scripts/dmg.mjs, which passes `app` (the
# packaged Gako.app) and `build` (shells/electron/build) as defines. The window shows Gako's icon
# and a link to Applications over build/dmg-background.png, whose arrow and text are drawn for
# these positions.

import os.path

app = defines["app"]  # noqa: F821 (dmgbuild provides `defines`)
build = defines["build"]  # noqa: F821

files = [app]
symlinks = {"Applications": "/Applications"}
icon = os.path.join(build, "icon.icns")
# dmg-background@2x.png, beside it, is picked up for Retina screens.
background = os.path.join(build, "dmg-background.png")

# LZFSE-compressed, read by macOS 10.11 and later.
format = "ULFO"

# The size includes the title bar, about 32 points tall since macOS 26, leaving 360 for the
# background.
window_rect = ((200, 120), (640, 392))
default_view = "icon-view"
show_toolbar = False
show_status_bar = False
show_tab_view = False
show_pathbar = False
show_sidebar = False

icon_size = 128
text_size = 13
icon_locations = {
    os.path.basename(app): (170, 150),
    "Applications": (470, 150),
}
