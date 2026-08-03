/**
 * PEP MA QC Portal — frontend configuration.
 *
 * API_URL: https://script.google.com/macros/s/AKfycbz0B_oL-cA4gztvs0FGJdP1jF45w0giRHtqDU6aocbx39NRRk_Hn8g9TD_N6_ptdgMp/exec
 *
 * DIRECT_IMAGES: when true the portal first tries to load photos straight
 *          from Google (fast). This only works if the photo folder is shared
 *          as "Anyone with the link - Viewer". If a direct load fails the
 *          portal automatically falls back to fetching the image through the
 *          API (slower but always works).
 */
window.QC_CONFIG = {
  API_URL: 'https://script.google.com/macros/s/AKfycbz0B_oL-cA4gztvs0FGJdP1jF45w0giRHtqDU6aocbx39NRRk_Hn8g9TD_N6_ptdgMp/exec',
  DIRECT_IMAGES: true,
  // Longest edge in pixels used when a photo comes through the API. 1600 is
  // about native size for these audit photos; raising it slows QC down.
  IMAGE_SIZE: 1600
};
