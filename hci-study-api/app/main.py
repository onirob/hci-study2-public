from fastapi import FastAPI, APIRouter
from .db import init_db, open_pool
from .routes import __init__ as root_router
from .routes.participants import router as participants_router  
from .routes.sessions import router as sessions_router
from .routes.surveys import router as surveys_router
from .routes.telemetry import router as telemetry_router
from .routes.dashboard import router as dashboard_router
from app.routes import chatbot as chatbot_routes
from contextlib import asynccontextmanager

app = FastAPI(title="HCI Study API", version="2.0")

@asynccontextmanager
async def lifespan(app: FastAPI):
    await open_pool()
    await init_db()
    try:
        yield
    finally:
        # perform any shutdown/cleanup here if needed (e.g. await close_pool())
        pass

# recreate app with lifespan manager
app = FastAPI(title="HCI Study API", version="2.0", lifespan=lifespan)

api_router = APIRouter(prefix="/api")

api_router.include_router(participants_router)
api_router.include_router(sessions_router)
api_router.include_router(surveys_router)
api_router.include_router(telemetry_router)
api_router.include_router(dashboard_router)
api_router.include_router(chatbot_routes.router)

app.include_router(api_router)