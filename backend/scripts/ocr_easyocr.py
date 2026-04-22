import sys


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: ocr_easyocr.py <image_path>", file=sys.stderr)
        return 2

    image_path = sys.argv[1]

    try:
        import easyocr  # type: ignore
    except Exception as exc:
        print(f"easyocr import failed: {exc}", file=sys.stderr)
        return 3

    try:
        reader = easyocr.Reader(["en"], gpu=False, verbose=False)
        lines = reader.readtext(image_path, detail=0, paragraph=True)
    except Exception as exc:
        print(f"easyocr run failed: {exc}", file=sys.stderr)
        return 4

    # Output plain text to stdout (Node reads stdout).
    if isinstance(lines, (list, tuple)):
        text = "\n".join(str(x).strip() for x in lines if str(x).strip())
    else:
        text = str(lines).strip()

    sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
