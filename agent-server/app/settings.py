"""에이전트 서버 환경 변수 (계약 16 §0). 값은 소스에 두지 않고 환경에서만 읽는다(SC-024)."""

import os
from dataclasses import dataclass, field


@dataclass(frozen=True)
class AgentSettings:
    # Next.js → 에이전트 호출을 증명하는 토큰(`X-Agent-Token`). 비어 있으면 /v1 경로를 아무도 못 부른다
    agent_api_token: str = field(repr=False)
    # 에이전트 → Next.js 내부 경로 호출 토큰(`X-Internal-Token`)
    internal_api_token: str = field(repr=False)
    next_internal_base_url: str
    llm_base_url: str
    # kdance-llm 이 내건 모델 별칭(SX-2.1(비전 서버 기동 확인) 실측: qwen3.5:9b)
    llm_vision_model: str
    # 글자 대화용 모델 별칭(SX-5.2(조건 뽑기)). 같은 kdance-llm 이 채팅·비전을 함께 낸다
    llm_chat_model: str
    # 홍보 이미지 엔진 Cloudflare Workers AI FLUX.1 [schnell](SX-6.4). 비어 있으면 그 엔진은 PROVIDER_ERROR 로 실패한다
    cloudflare_account_id: str = field(repr=False)
    cloudflare_api_token: str = field(repr=False)


def load_settings() -> AgentSettings:
    return AgentSettings(
        agent_api_token=os.environ.get("AGENT_API_TOKEN", ""),
        internal_api_token=os.environ.get("INTERNAL_API_TOKEN", ""),
        next_internal_base_url=os.environ.get("NEXT_INTERNAL_BASE_URL", "http://localhost:3000"),
        llm_base_url=os.environ.get("LLM_BASE_URL", "http://localhost:11436/v1"),
        llm_vision_model=os.environ.get("LLM_VISION_MODEL", "qwen3.5:9b"),
        llm_chat_model=os.environ.get("LLM_CHAT_MODEL", "qwen3.5:9b"),
        cloudflare_account_id=os.environ.get("CLOUDFLARE_ACCOUNT_ID", ""),
        cloudflare_api_token=os.environ.get("CLOUDFLARE_API_TOKEN", ""),
    )
