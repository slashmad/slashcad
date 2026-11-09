"""WebKitGTK side of the WebGL bench, using webkit2gtk-4.1 (the API Tauri 2 uses on Linux).

Usage: /usr/bin/python3 webkitgtk_runner.py <url>
"""
import sys

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import Gtk, WebKit2  # noqa: E402

win = Gtk.Window(title="webkitgtk bench")
win.set_default_size(1600, 1000)
view = WebKit2.WebView()
s = view.get_settings()
s.set_enable_webgl(True)
s.set_hardware_acceleration_policy(WebKit2.HardwareAccelerationPolicy.ALWAYS)
win.add(view)
win.connect("destroy", Gtk.main_quit)
view.load_uri(sys.argv[1])
win.show_all()
Gtk.main()
