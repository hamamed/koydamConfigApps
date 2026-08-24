# Wallpapers

Drop image files in here and they appear in the app under **More → Wallpapers**.

* `.jpg` `.jpeg` `.png` `.webp` are served. Anything else is ignored, which is
  why this README does not show up as a wallpaper.
* A **subfolder becomes a category** and its name becomes the filter chip.
  Files placed directly in this folder are uncategorised.
* Only one level deep. Nesting further is ignored rather than flattened, so you
  can keep your own originals in a sub-subfolder without publishing them.
* The **filename becomes the title**: `cool-shelly_01.png` shows as
  "Cool Shelly 01".

Example:

    wallpapers/
      brawlers/
        shelly-splash.png      -> "Shelly Splash",  category "brawlers"
        el-primo.jpg           -> "El Primo",       category "brawlers"
      maps/
        gem-grab-hard-rock.png -> "Gem Grab Hard Rock", category "maps"
      welcome-banner.png       -> "Welcome Banner", no category

## Notes

* The listing is cached for `TTL_WALLPAPERS` seconds (default 120), so a new
  file takes up to two minutes to appear. The images themselves are cached by
  the browser/app for a week, so **replace an image by giving it a new name**
  rather than overwriting it.
* This folder is deliberately not part of the deploy archive. `tar x` only
  overwrites what it contains, so what you upload here survives an update.
* Phone wallpapers want portrait art — roughly 1080×1920 or taller. The app
  reads each file's real dimensions and lays the grid out accordingly, so
  mixed sizes are fine, but landscape images will look like landscape images.
* Set `WALLPAPER_DIR` in `.env` to serve from somewhere else entirely, such as
  a larger mounted disk.
