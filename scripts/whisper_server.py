"""Long-lived Whisper transcriber.

Loading the model costs seconds, so it happens once at startup rather than per
turn — the same reason piper_server.py stays resident. Reads
{"id", "pcm", "sampleRate"} lines on stdin, where pcm is base64 float32
little-endian mono, and writes {"type": "text", "id", "text"} back.

English is forced rather than detected: detection costs an extra pass and this
is an English voice interface. The accent is the point, not the language.
"""

import base64
import json
import sys
import warnings

# numpy 2.x makes faster-whisper's feature extractor emit divide-by-zero and
# overflow RuntimeWarnings on every transcription. The output is correct, and
# stdout is a protocol — a warning printed into it would be read as a message.
warnings.filterwarnings("ignore", category=RuntimeWarning)

import numpy as np
from faster_whisper import WhisperModel


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main():
    name = sys.argv[1] if len(sys.argv) > 1 else "base"
    try:
        model = WhisperModel(name, device="cpu", compute_type="int8")
    except Exception as exc:  # noqa: BLE001 - report and exit; the parent falls back
        emit({"type": "error", "message": f"failed to load {name}: {exc}"})
        return 1

    emit({"type": "ready"})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except ValueError:
            continue
        if message.get("cmd") == "quit":
            return 0
        try:
            audio = np.frombuffer(base64.b64decode(message["pcm"]), dtype=np.float32)
            segments, _ = model.transcribe(audio, language="en", beam_size=1)
            text = " ".join(s.text for s in segments).strip()
            emit({"type": "text", "id": message.get("id"), "text": text})
        except Exception as exc:  # noqa: BLE001 - one bad turn must not end the process
            emit({"type": "error", "id": message.get("id"), "message": str(exc)})

    return 0


if __name__ == "__main__":
    sys.exit(main())
