/** "No music" is stored as an empty id and must never be downloaded. */
export function shouldSkipAudioDownload(videoId: string): boolean {
  return !videoId.length;
}

/** An empty cached id means the user explicitly chose "No Music". */
export function isCachedNoMusic(videoId: string | undefined): boolean {
  return videoId !== undefined && videoId.length === 0;
}
