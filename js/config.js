/**
 * PEP MA QC Portal — frontend configuration.
 *
 * API_URL: paste the Google Apps Script web app URL here after deploying
 *          apps-script/Code.gs (Deploy -> New deployment -> Web app).
 *          It looks like: https://script.google.com/macros/s/AKfyc.../exec
 *
 * DIRECT_IMAGES: when true the portal first tries to load photos straight
 *          from Google (fast). This only works if the photo folder is shared
 *          as "Anyone with the link - Viewer". If a direct load fails the
 *          portal automatically falls back to fetching the image through the
 *          API (slower but always works).
 */
window.QC_CONFIG = {
  API_URL: 'PASTE_YOUR_APPS_SCRIPT_WEB_APP_URL_HERE',
  DIRECT_IMAGES: true,
  IMAGE_SIZE: 2400
};
