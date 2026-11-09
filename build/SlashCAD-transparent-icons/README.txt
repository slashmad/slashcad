SlashCAD – icons with transparent background

SOURCE: The approved "mekanisk_skalle_med_röd_slash.png" artwork.
The plain white background was removed while preserving the white teeth, eye highlights and smoke.

slashcad-transparent-1024.png: exact design as a transparent RGBA bitmap.
slashcad.svg: transparent SVG wrapper with an embedded PNG. Visual appearance is preserved, BUT this is NOT native vector geometry.
slashcad-vector-trace.svg: real SVG path geometry from posterization and contour tracing. This is a stylized approximation, not a lossless original.
hicolor/*/apps/slashcad.png: Linux PNG icon theme standard structure.
hicolor/scalable/apps/slashcad.svg: faithful wrapped bitmap SVG.
slashcad.ico: multi-resolution Windows icon.
preview.png: preview on white/light gray and dark backgrounds.

For Linux installation: 
  mkdir -p ~/.local/share/icons/hicolor
  cp -r hicolor/* ~/.local/share/icons/hicolor/
  gtk-update-icon-cache -f -t ~/.local/share/icons/hicolor  # if installed; optional

For a local .desktop launcher: Icon=slashcad
Or point Icon= to an absolute path of the 256px or 512px PNG.
