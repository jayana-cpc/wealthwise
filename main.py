from fastapi import FastAPI, File, HTTPException, UploadFile
from csv_parsing import PositionsPayload, parse_positions_csv


app = FastAPI(title="WealthWise CSV API", version="0.1.0")


@app.post("/upload-csv", response_model=PositionsPayload)
async def upload_csv(file: UploadFile = File(...)) -> PositionsPayload:
    if not file or not file.filename:
        raise HTTPException(status_code=400, detail="File not uploaded.")
    if not file.filename.lower().endswith(".csv"):
        raise HTTPException(status_code=400, detail="Uploaded file must be a CSV.")

    try:
        raw_bytes = await file.read()
        text = raw_bytes.decode("utf-8-sig")
        return parse_positions_csv(text)
    except UnicodeDecodeError as exc:
        raise HTTPException(status_code=400, detail="Unable to decode file as UTF-8.") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
