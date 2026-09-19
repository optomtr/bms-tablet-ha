"""Device identity separate from HA access tokens. No plaintext device secrets on disk."""
from __future__ import annotations
import asyncio
import copy
import hashlib
import hmac
import logging
import re
import secrets
import time
from collections import OrderedDict
from datetime import timedelta
from .persist import StrictStore

_LOGGER=logging.getLogger(__name__)
HEX=re.compile(r'^[0-9a-f]{64}$')
ID=re.compile(r'^[0-9a-f]{32}$')
ALPHABET='23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
DAY=86400
SESSIONS_TOTAL=32
# Один адрес держит не больше стольких неподтверждённых кодов: чужой в сети
# не вытеснит код настоящего планшета, а только свои собственные.
SESSIONS_PER_IP=3

def fingerprint(value):
    if not isinstance(value,str) or not HEX.fullmatch(value): raise PairError(400,'invalid_secret')
    return hashlib.sha256(value.encode()).hexdigest()

class PairError(Exception):
    def __init__(self,status,code): self.status=status; self.code=code; super().__init__(code)

class PairingManager:
    def __init__(self,hass):
        # private: 0600; запись атомарная и с ошибкой наверх — откат в renew/approve настоящий.
        self.hass=hass; self.storage=StrictStore(hass,1,'bms_tablet.identities',private=True)
        self.devices={}; self.sessions=OrderedDict(); self.rates=OrderedDict(); self.lock=asyncio.Lock()
        self.seen={}  # user_id -> время последнего запроса (в памяти, не на диск)

    async def load(self):
        data=await self.storage.async_load()
        self.devices=(data or {}).get('devices',{})
        # A durable tombstone prevents renewal even if revoking HA access was interrupted.
        for device in list(self.devices.values()):
            if device.get('revoked'): await self._remove_user(device)

    async def _save(self,devices):
        await self.storage.async_save({'devices':devices})
        self.devices=devices

    def limit(self,ip):
        now=time.monotonic(); key=str(ip or 'unknown')
        events=self.rates.pop(key,[]); events=[t for t in events if now-t<60]
        self.rates[key]=events
        if len(self.rates)>1024: self.rates.popitem(last=False)
        if len(events)>=30: raise PairError(429,'rate_limited')
        events.append(now)

    def prune(self):
        now=time.time()
        for code in list(self.sessions):
            if self.sessions[code]['until']<now: del self.sessions[code]

    async def start(self,data,ip=None):
        digest=fingerprint(data.get('secret'))
        name=data.get('name','BMS Tablet')
        if not isinstance(name,str) or not 1<=len(name)<=80: raise PairError(400,'invalid_name')
        async with self.lock:
            self.prune()
            # Retried start with the same secret keeps the same device code.
            for code,s in self.sessions.items():
                if hmac.compare_digest(s['hash'],digest): return {'code':code,'device_id':s['id'],'expires_in':max(0,int(s['until']-time.time()))}
            source=str(ip or 'unknown')
            mine=[c for c,s in self.sessions.items() if s.get('ip')==source and not s.get('approved')]
            if len(mine)>=SESSIONS_PER_IP: del self.sessions[mine[0]]
            # Таблица полна — отказ, а не вытеснение кода с чужого адреса.
            elif len(self.sessions)>=SESSIONS_TOTAL: raise PairError(429,'pairing_busy')
            code=''.join(secrets.choice(ALPHABET) for _ in range(6))
            while code in self.sessions: code=''.join(secrets.choice(ALPHABET) for _ in range(6))
            device_id=secrets.token_hex(16)
            self.sessions[code]={'id':device_id,'name':name,'hash':digest,'until':time.time()+600,'ip':source}
            return {'code':code,'device_id':device_id,'expires_in':600}

    async def status(self,data):
        digest=fingerprint(data.get('secret')); device_id=data.get('device_id')
        if not isinstance(device_id,str) or not ID.fullmatch(device_id): raise PairError(400,"invalid_request")
        self.prune()
        for s in self.sessions.values():
            if s['id']==device_id and hmac.compare_digest(s['hash'],digest):
                return {'approved':bool(s.get('approved'))}
        # Approved identity survives a server restart and session expiry.
        d=self.devices.get(device_id,{})
        if not d.get('revoked') and hmac.compare_digest(d.get('hash',''),digest): return {'approved':True}
        raise PairError(403,'identity_unknown')

    async def approve(self,code,admin):
        if not isinstance(code,str) or len(code)!=6: raise PairError(400,'invalid_code')
        async with self.lock:
            self.prune(); session=self.sessions.get(code.upper())
            if session is None: raise PairError(404,'code_expired')
            if session.get('approved'): return {'device_id':session['id']}
            if len(self.devices)>=512: raise PairError(429,'device_limit')
            # A separate non-administrator HA user isolates revocation per tablet.
            user=await self.hass.auth.async_create_system_user('BMS · '+session['name'],group_ids=['system-users'])
            try:
                devices=copy.deepcopy(self.devices)
                devices[session['id']]={'name':session['name'],'user_id':user.id,'hash':session['hash'],'created':time.time(),'approved_by':admin}
                await self._save(devices)
            except BaseException:
                await self.hass.auth.async_remove_user(user); raise
            session['approved']=True
            _LOGGER.info('BMS device approved: %s by %s',session['id'],admin)
            return {'device_id':session['id']}

    async def renew(self,data,ip=None):
        device_id=data.get('device_id'); request_id=data.get('request_id')
        if not isinstance(device_id,str) or not ID.fullmatch(device_id) or not isinstance(request_id,str) or not ID.fullmatch(request_id): raise PairError(400,'invalid_request')
        digest=fingerprint(data.get('secret')); next_hash=fingerprint(data.get('next_secret'))
        if hmac.compare_digest(digest,next_hash): raise PairError(400,'rotation_required')
        async with self.lock:
            d=self.devices.get(device_id)
            if not d or d.get('revoked'): raise PairError(403,'identity_unknown')
            now=time.time()
            current=hmac.compare_digest(d['hash'],digest)
            replay=(now<d.get('prev_until',0) and hmac.compare_digest(d.get('prev_hash',''),digest)
                    and d.get('request_id')==request_id and hmac.compare_digest(d['hash'],next_hash))
            if not current and not replay: raise PairError(403,'identity_unknown')
            user=await self.hass.auth.async_get_user(d['user_id'])
            if user is None or not user.is_active: raise PairError(403,'identity_unknown')
            refresh=self.hass.auth.async_get_refresh_token(d.get('token_id',''))
            # Never let a record point at another HA user's token.
            if refresh is not None and refresh.user.id!=user.id: raise PairError(409,'identity_conflict')
            if current and refresh is not None and now-d.get('renewed',0)<DAY: raise PairError(429,'renew_too_soon')
            created=current or refresh is None
            if created:
                refresh=await self.hass.auth.async_create_refresh_token(user,access_token_expiration=timedelta(days=3650))
            try:
                if current:
                    devices=copy.deepcopy(self.devices); updated=devices[device_id]
                    updated.update(hash=next_hash,prev_hash=digest,prev_until=now+7*DAY,request_id=request_id,token_id=refresh.id,renewed=now)
                    # Кто и откуда обновил доступ — видно админу: угон по http не пройдёт молча.
                    updated.update(last_renew_at=now,last_ip=str(ip or ''),last_seen=now)
                    await self._save(devices)
                elif created:
                    devices=copy.deepcopy(self.devices); devices[device_id]['token_id']=refresh.id
                    devices[device_id].update(last_renew_at=now,last_ip=str(ip or ''),last_seen=now)
                    await self._save(devices)
                token=self.hass.auth.async_create_access_token(refresh)
                for previous in list(user.refresh_tokens.values()):
                    if previous.id != refresh.id: self.hass.auth.async_remove_refresh_token(previous)
            except BaseException:
                if created: self.hass.auth.async_remove_refresh_token(refresh)
                raise
            _LOGGER.info('BMS device token %s: %s','replayed' if replay else 'renewed',device_id)
            return {'access_token':token,'device_id':device_id,'request_id':request_id}

    async def _remove_user(self,device):
        user=await self.hass.auth.async_get_user(device['user_id'])
        if user:
            for token in list(user.refresh_tokens.values()): self.hass.auth.async_remove_refresh_token(token)
            await self.hass.auth.async_remove_user(user)

    async def revoke(self,device_id,admin):
        async with self.lock:
            if device_id not in self.devices: return {}
            devices=copy.deepcopy(self.devices); record=devices[device_id]
            record.update(revoked=True); record.pop('hash',None); record.pop('prev_hash',None)
            await self._save(devices)
            await self._remove_user(record)
            for code in list(self.sessions):
                if self.sessions[code]['id']==device_id: del self.sessions[code]
            _LOGGER.warning('BMS device revoked: %s by %s',device_id,admin)
            return {}

    def device_for_user(self,user_id):
        """Привязанный и не отозванный планшет, которому принадлежит пользователь HA."""
        for key,d in self.devices.items():
            if d.get('user_id')==user_id and not d.get('revoked'): return key
        return None

    def mark_seen(self,user_id):
        self.seen[user_id]=time.time()

    def listing(self):
        return [{'device_id':key,'name':d['name'],'revoked':bool(d.get('revoked')),'renewed':d.get('renewed'),
                 'last_renew_at':d.get('last_renew_at'),'last_ip':d.get('last_ip'),
                 'last_seen':max(filter(None,(d.get('last_seen'),self.seen.get(d.get('user_id')))),default=None)}
                for key,d in self.devices.items()]
