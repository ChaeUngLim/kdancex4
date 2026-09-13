from fastapi import FastAPI

app = FastAPI(title="kdance")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
