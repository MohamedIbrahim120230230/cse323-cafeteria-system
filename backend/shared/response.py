from fastapi.responses import JSONResponse

def ok(data, status: int = 200):
    return JSONResponse({"success": True, "data": data}, status_code=status)

def err(code: str, message: str, details=None, status: int = 400):
    return JSONResponse(
        {"success": False, "error": {"code": code, "message": message, "details": details}},
        status_code=status,
    )
