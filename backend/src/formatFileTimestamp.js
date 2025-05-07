
/**
 * @param {string} filename 
 * @returns {string}
 */
function formatFileTimestamp(filename) {
  // 1) extract the basic‐ISO timestamp (YYYYMMDDThhmmssZ)
  const m = filename.match(/^(\d{8}T\d{6}Z)/);
  if (!m) throw new Error('Filename does not start with YYYYMMDDThhmmssZ');

  const basic = m[1];  // e.g. "20250503T203813Z"

  // 2) convert to a true ISO string: "2025-05-03T20:38:13Z"
  const isoUTC = basic.replace(
    /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
    '$1-$2-$3T$4:$5:$6Z'
  );

  // 3) parse into a Date
  const d = new Date(isoUTC);

  // 4) pull out local components
  const Y = d.getFullYear();
  const M = String(d.getMonth() + 1).padStart(2, '0');
  const D = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const m2 = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');

  // 5) compute local timezone offset in ±HHMM
  //    getTimezoneOffset() returns the minutes you must add to local
  //    to get to UTC, so e.g. for PDT (UTC-7) it returns +420.
  let offset = d.getTimezoneOffset();        // in minutes
  const sign = offset > 0 ? '-' : '+';      // positive offset = behind UTC
  offset = Math.abs(offset);
  const offH = String(Math.floor(offset / 60)).padStart(2, '0');
  const offM = String(offset % 60).padStart(2, '0');

  return `${Y}-${M}-${D}T${h}:${m2}:${s}${sign}${offH}${offM}`;
}

module.exports = {
    formatFileTimestamp,
}
