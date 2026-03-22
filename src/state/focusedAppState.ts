let focusedPlayerAppId: number | null = null;

export function getFocusedPlayerAppId(): number | null {
  return focusedPlayerAppId;
}

export function setFocusedPlayerAppId(appId: number | null): void {
  focusedPlayerAppId = appId;
}
