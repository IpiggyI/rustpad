/** Tracks IME composition so controlled inputs do not rewrite the native buffer. */
export function createImeGate() {
  let composing = false;

  return {
    start() {
      composing = true;
    },
    end() {
      composing = false;
    },
    isComposing() {
      return composing;
    },
    /** Forward a native `input`/`change` to parent state only when composition is idle. */
    shouldEmitChange(eventIsComposing: boolean): boolean {
      return !composing && !eventIsComposing;
    },
    /** Incoming `value` may be written to the DOM only when composition is idle. */
    shouldApplyExternalValue(): boolean {
      return !composing;
    },
  };
}
