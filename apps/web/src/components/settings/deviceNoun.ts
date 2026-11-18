/** "Mac" when this client runs on one, else "device". */
export function thisDeviceNoun(): string {
  if (typeof navigator === "undefined") return "device";
  // iPads report a Mac platform; touch tells them apart.
  return /Mac/.test(navigator.platform) && navigator.maxTouchPoints <= 1 ? "Mac" : "device";
}

/** "Mac" on a Mac, else "machine", for a computer this app runs on. */
export function thisMachineNoun(): string {
  const noun = thisDeviceNoun();
  return noun === "device" ? "machine" : noun;
}
