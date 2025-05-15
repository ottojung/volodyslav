/**
 * @param {string} filename 
 * @returns {Date}
 */
function formatFileTimestamp(filename) {
  // 1) extract the basic‐ISO timestamp (YYYYMMDDThhmmssZ)
  const m = filename.match(/^(\d{8}T\d{6}Z)[.].*/);
  if (!m) throw new Error('Filename does not start with YYYYMMDDThhmmssZ');

  const basic = m[1];

  // 2) convert to a true ISO string: "YYYY-MM-DDThh:mm:ssZ"
  const isoUTC = basic.replace(
    /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
    '$1-$2-$3T$4:$5:$6Z'
  );

  // 3) parse into a Date
  const d = new Date(isoUTC);

  return d;
}

module.exports = {
    formatFileTimestamp,
}
