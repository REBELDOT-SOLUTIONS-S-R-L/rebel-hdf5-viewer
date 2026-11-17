# Brand fonts (not in the repository)

Headings use **Basier Circle**, RebelDot's brand typeface. It is a commercial
font, so the files are gitignored and never committed to this public repository.

To build with it, copy these four webfonts into this folder:

- `basiercircle-regular-webfont.woff2`
- `basiercircle-medium-webfont.woff2`
- `basiercircle-semibold-webfont.woff2`
- `basiercircle-bold-webfont.woff2`

RebelDot colleagues can get them from the brand assets (Basier.zip) or the
RebelDot offer-deck skill's `assets/fonts/` folder.

Without them the app works the same and headings fall back to Inter. A copy of
Basier Circle installed on the machine is used first.

A build made with the fonts in place contains them (Vite copies this folder into
`dist/`). Only distribute such a build where RebelDot's font licence allows it.
