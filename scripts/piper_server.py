"""Long-lived Piper synthesizer.

Loading the model costs ~230ms, so it happens once at startup rather than per
sentence. Reads {"id", "text"} lines on stdin, streams base64 PCM back on stdout
as it synthesizes, so playback can start on the first chunk (~300ms) instead of
waiting for the whole utterance.
"""

import base64
import json
import sys

from piper import PiperVoice


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main():
    if len(sys.argv) < 3:
        emit({"type": "error", "message": "usage: piper_server.py MODEL CONFIG"})
        return 1

    try:
        voice = PiperVoice.load(sys.argv[1], config_path=sys.argv[2])
    except Exception as exc:  # noqa: BLE001 - report and exit, the parent falls back
        emit({"type": "error", "message": f"failed to load voice: {exc}"})
        return 1

    emit({"type": "ready", "sampleRate": voice.config.sample_rate})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except ValueError:
            continue

        if request.get("cmd") == "quit":
            break

        text = request.get("text", "").strip()
        uid = request.get("id")
        if not text:
            continue

        try:
            for chunk in voice.synthesize(text):
                emit({
                    "type": "audio",
                    "id": uid,
                    "data": base64.b64encode(chunk.audio_int16_bytes).decode("ascii"),
                })
            emit({"type": "end", "id": uid})
        except Exception as exc:  # noqa: BLE001 - one bad utterance must not kill the server
            emit({"type": "error", "id": uid, "message": str(exc)})

    return 0


if __name__ == "__main__":
    sys.exit(main())
