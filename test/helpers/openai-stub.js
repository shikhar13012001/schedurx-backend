// Shaped like an OpenAI client — the .chat.completions.create() surface
// openai-service.js's chatCompletion() calls, plus .audio.transcriptions.create()
// for transcribeAudio().
function createOpenaiStub({ content = "{}", transcript = "" } = {}) {
  return {
    chat: {
      completions: {
        async create() {
          return { choices: [{ message: { content } }] };
        },
      },
    },
    audio: {
      transcriptions: {
        async create() {
          return { text: transcript };
        },
      },
    },
  };
}

module.exports = { createOpenaiStub };
