// One call site, two surfaces.
//
// The orchestrator should not have to remember to tell both the terminal and the
// window about everything that happens — that is exactly the kind of bookkeeping
// that drifts, and a window showing half the conversation is worse than no
// window. Everything it says goes through here instead.

/**
 * @param {import('./ui.mjs').Ui} ui                   terminal renderer
 * @param {import('./bus.mjs').Conversation} conversation  state for the window
 */
export function makeView(ui, conversation) {
  return {
    banner(info) {
      ui.banner(info);
      conversation.banner(info);
    },

    you(text) {
      ui.you(text);
      conversation.you(text);
    },

    /** A sentence handed to the synthesizer. `first` leads a new answer. */
    opus(text, first) {
      ui.opus(text, first);
      conversation.opus(text, first);
    },

    note(text) {
      ui.note(text);
      conversation.system(text);
    },

    /** Speech captured in note mode. */
    heard(text) {
      ui.heard(text);
      conversation.heard(text);
    },

    /** Speech ignored because it is asleep. */
    ignored(text) {
      ui.ignored(text);
      conversation.ignored(text);
    },

    mode(name) {
      ui.mode(name);
      conversation.setMode(name);
    },

    warn(text) {
      ui.warn(text);
      conversation.warn(text);
    },

    error(text) {
      ui.error(text);
      conversation.error(text);
    },

    /** Interim recognition, replaced as it changes. */
    hearing(text) {
      ui.hearing(text);
      conversation.hearing(text);
    },

    /** A tool call: a status in the terminal, a line in the window. */
    tool(name) {
      ui.spin(`${name.toLowerCase()}…`);
      conversation.tool(name);
      conversation.setStatus(name.toLowerCase());
    },

    /** Animated status such as "thinking". */
    spin(label) {
      ui.spin(label);
      conversation.setStatus(label);
    },

    /** Marks the last answer as cut off rather than dropping the tail silently. */
    interrupted() {
      ui.note('(interrupted)');
      conversation.interrupted();
    },

    /** The list changed: the window redraws, the terminal stays quiet. */
    todos(list) {
      conversation.setTodos(list);
    },

    speaking(on) {
      conversation.setSpeaking(on);
    },

    clearLive() {
      ui.clearLive();
      conversation.setStatus(null);
      conversation.clearHearing();
    },

    close() {
      ui.close();
    },
  };
}
