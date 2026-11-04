export interface VoiceCall {
  /** Who the call is with, such as "Shift" or the thread's title. */
  readonly caller: string;
  readonly status: string;
  readonly muted: boolean;
}

export type VoiceCallAction = "end" | "mute";
