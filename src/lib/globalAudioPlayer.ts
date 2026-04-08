class GlobalAudioPlayer {
  private static instance: GlobalAudioPlayer;
  private audioElement: HTMLAudioElement;

  private constructor() {
    this.audioElement = new Audio();
    this.audioElement.preload = 'auto';
    this.audioElement.loop = true;
  }

  static getInstance(): GlobalAudioPlayer {
    if (!GlobalAudioPlayer.instance) {
      GlobalAudioPlayer.instance = new GlobalAudioPlayer();
    }
    return GlobalAudioPlayer.instance;
  }

  getAudioElement(): HTMLAudioElement {
    return this.audioElement;
  }
}

export default GlobalAudioPlayer;
