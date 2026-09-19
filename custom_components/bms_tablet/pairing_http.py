"""Bounded public bootstrap endpoint; possession of the device secret is mandatory."""
import asyncio
import json
import logging
from aiohttp import web
from homeassistant.components.http import HomeAssistantView
from .const import DOMAIN
from .pairing import PairError
_LOGGER=logging.getLogger(__name__)

class PairingView(HomeAssistantView):
    url='/api/bms_tablet/pair/{action}'
    name='api:bms_tablet:pair'
    requires_auth=False
    def __init__(self,hass): self.hass=hass
    async def post(self,request,action):
        manager=self.hass.data.get(DOMAIN,{}).get('pairing')
        headers={'Cache-Control':'no-store','Pragma':'no-cache'}
        if manager is None: return web.json_response({'error':'integration_unavailable'},status=503,headers=headers)
        try:
            manager.limit(request.remote)
            if request.headers.get('Origin'): raise PairError(403,'browser_not_allowed')
            if action not in ('start','status','renew'): raise PairError(404,'not_found')
            if request.content_type!='application/json': raise PairError(400,'json_required')
            async with asyncio.timeout(10):
                body=bytearray()
                async for chunk in request.content.iter_chunked(4096):
                    body.extend(chunk)
                    if len(body)>8192: raise PairError(413,'request_too_large')
                data=json.loads(body)
            if not isinstance(data,dict): raise PairError(400,'invalid_request')
            if action=='status': result=await manager.status(data)
            else: result=await getattr(manager,action)(data,ip=request.remote)
            return web.json_response(result,headers=headers)
        except PairError as error:
            return web.json_response({'error':error.code},status=error.status,headers=headers)
        # RecursionError: json.loads на «[[[[…» — это мусор от клиента, а не сбой сервера.
        except (ValueError,TypeError,TimeoutError,RecursionError):
            return web.json_response({'error':'invalid_request'},status=400,headers=headers)
        except Exception:
            _LOGGER.exception('BMS pairing operation failed (credentials omitted)')
            return web.json_response({'error':'temporarily_unavailable'},status=503,headers=headers)
