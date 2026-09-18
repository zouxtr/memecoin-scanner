"""
Вход на приложението.

РЕАЛНО-ВРЕМЕВА версия: вместо да чака фиксирани N минути и да оцени
монетата само веднъж (което пропуска ранните pump-ове), сега при всяко
graduation стартираме monitoring task, който проверява монетата на всеки
config.POLL_INTERVAL_SECONDS секунди в рамките на config.MONITOR_WINDOW_MINUTES
минути и праща алърт веднага щом реално наблюдаваният моментум + ликвидност/
обем пресекат прага - не на фиксирана минута.

Render-съвместимо: мъничък Flask health-check сървър + фонов asyncio loop.

Локално: python main.py
На Render: Start Command = python main.py
"""
import asyncio
import logging
import os
import threading
import time
from datetime import datetime, timedelta, timezone

import requests
from flask import Flask, jsonify, request

import config
from pumpportal_client import listen_for_migrations
from data_sources import get_dexscreener_pairs_batch, get_dexscreener_pairs, get_rugcheck_report, extract_mint_address
from scoring import score_token
from seen_store import load_seen, mark_seen
from notifier import send_alert, can_send_now

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
log = logging.getLogger("main")

# --- Стартова самопроверка ---
# Реален случай (17.09): локалният config.py беше стара версия - липсваше
# config.BLOCK_ON_LOW_LIQUIDITY_RISK - и score_token() гърмеше с
# AttributeError за АБСОЛЮТНО ВСЯКА монета. Ботът изглеждаше "жив"
# (health-check-ът минаваше, PumpPortal слушаше), но реално не пращаше
# НИКАКЪВ алърт часове наред, защото всяка monitor_token() задача умираше
# тихо на първия score_token() опит (само WARNING в логовете, по един ред
# на монета - лесно за пропускане). _startup_self_check() хваща точно
# този клас бъг (config.py разминат/непълен спрямо scoring.py) веднага при
# стартиране, с ясна CRITICAL грешка и спиране на процеса, вместо часове/
# дни по-късно да разбираме случайно от липсващи алърти.
REQUIRED_CONFIG_ATTRS = [
    "PUMPPORTAL_WS_URL", "INITIAL_INDEX_DELAY_SECONDS", "POLL_INTERVAL_SECONDS",
    "MONITOR_WINDOW_MINUTES", "MIN_POLLS_BEFORE_ALERT", "PEAK_DRAWDOWN_STOP_PCT",
    "MIN_LP_LOCKED_PCT", "BLOCK_ON_LOW_LIQUIDITY_RISK", "MIN_LIQUIDITY_USD",
    "MAX_INSIDER_CLUSTERS", "RUGCHECK_REFRESH_EVERY_N_POLLS", "MAX_MARKET_CAP_USD",
    "HIGH_POTENTIAL_THRESHOLD", "FINAL_CHECK_MAX_DRAWDOWN_PCT", "IMPERSONATION_KEYWORDS",
    "IMPERSONATION_LEGITIMACY_WORDS", "ALERT_EMAIL_ENABLED", "RESEND_API_KEY",
    "RESEND_FROM_EMAIL", "ALERT_EMAIL_TO", "MIN_EMAIL_INTERVAL_SECONDS",
    "MAX_EMAILS_PER_DAY", "ALERT_QUIET_HOURS_TZ", "PORT", "KEEP_ALIVE_PING_MINUTES",
    # --- добавени 18.09 при цялостен преглед на кода - тези липсваха от
    # проверката, въпреки че се четат реално от бота (main.py при модулно
    # ниво/load_seen, scoring.py за "разширената зона"/wash-trading защитите) ---
    "EXTENDED_MAX_MARKET_CAP_USD", "EXTENDED_ZONE_MIN_LIQUIDITY_USD",
    "MAX_VOLUME_TO_LIQUIDITY_RATIO", "DATA_DIR", "SEEN_FILE",
    "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN",
    "ALERT_ACTIVE_START_HOUR", "ALERT_ACTIVE_START_MINUTE",
    "ALERT_ACTIVE_END_HOUR", "ALERT_ACTIVE_END_MINUTE",
]


def _startup_self_check():
    missing = [name for name in REQUIRED_CONFIG_ATTRS if not hasattr(config, name)]
    if missing:
        log.critical(
            "СТАРТОВА ПРОВЕРКА ПРОВАЛЕНА: config.py липсват настройки: %s. "
            "Най-вероятно файлът (локално или на Render) е стара/непълна версия - "
            "провери git push/pull и redeploy-ни. Спирам стартирането, вместо да "
            "оставя всяка монета да крашва тихо във фона.",
            ", ".join(missing),
        )
        raise SystemExit(1)

    fake_pair = {
        "liquidity": {"usd": 20000},
        "marketCap": 50000,
        "fdv": 50000,
        "baseToken": {"name": "SelfTestCoin", "symbol": "SELFTEST"},
        "volume": {"h1": 10000},
    }
    fake_rugcheck = {"risks": [], "markets": [], "graphInsidersDetected": 0}
    try:
        score_token("SelfTest11111111111111111111111111111111111", fake_pair, fake_rugcheck, momentum_pct=30.0)
    except Exception as e:
        log.critical(
            "СТАРТОВА ПРОВЕРКА ПРОВАЛЕНА: score_token() гърми на синтетичен тест "
            "(%s) - има бъг/несъответствие между config.py и scoring.py. Спирам "
            "стартирането, вместо да оставя всяка монета да крашва тихо.",
            e,
        )
        raise SystemExit(1)

    log.info("Стартова самопроверка: config.py и scoring.py изглеждат съвместими.")


# ВАЖНО (18.09, намерено при цялостен преглед на кода): _startup_self_check()
# трябва да се извика ТУК, ПРЕДИ load_seen() по-долу - иначе load_seen() (чете
# config.DATA_DIR/SEEN_FILE/UPSTASH_REDIS_REST_URL/TOKEN) може да гръмне с
# гол, неясен AttributeError при стар/непълен config.py, преди самата
# самопроверка изобщо да успее да покаже ясната CRITICAL диагностика по-горе.
# main() по-долу вече НЕ вика проверката пак - извикана е веднъж, тук, при
# импортиране на модула.
_startup_self_check()

app = Flask(__name__)
_status = {
    "started_at": None,
    "last_migration_at": None,
    "last_alert_at": None,
    "seen_count": 0,
    "currently_monitoring": [],
}
_seen = load_seen()
_monitoring = set()
# Заключва достъпа до _monitoring - мутира се от asyncio нишката
# (monitor_token добавя/маха mint-ове), а се ЧЕТЕ както от Flask нишката
# (health() route по-долу), така и от _refresh_market_data_loop - без
# заключване, list(_monitoring) точно докато друга нишка прави add()/
# discard() може да гръмне с "RuntimeError: Set changed size during
# iteration" (намерено при цялостен преглед на кода, 18.09).
_monitoring_lock = threading.Lock()

# Споделен кеш с последните DexScreener данни за всяка следена монета -
# пълни се от ЕДИН централен loop (_refresh_market_data_loop), който прави
# batch заявки (до 30 адреса наведнъж) вместо всяка следена монета да си
# праща собствена HTTP заявка на всеки poll. Причина (17.09, живи Render
# логове): при 20+ едновременно следени монети, толкова отделни заявки на
# всеки ~60с редовно удряха DexScreener rate limit-а (429 Too Many Requests),
# което губеше/забавяше ценови данни точно когато монетата реално мърда.
_market_data_cache: dict = {}


async def scan_coin(mint_address: str) -> dict:
    """Standalone per-coin check, extracted from the polling loop.

    Reuses the existing DexScreener/RugCheck calls (data_sources.py) and
    scoring (scoring.py) without changing scoring logic. On-demand scans
    have no price history, so momentum is 0.0 (same as a first poll).
    Returns score, liquidity, volume, momentum and risk flags as a dict.
    """
    pairs, rugcheck_report = await asyncio.gather(
        asyncio.to_thread(get_dexscreener_pairs, mint_address),
        asyncio.to_thread(get_rugcheck_report, mint_address),
    )
    best_pair = pairs[0] if pairs else {}
    momentum_pct = 0.0
    result = score_token(mint_address, best_pair, rugcheck_report, momentum_pct)
    volume_h1 = (best_pair.get("volume") or {}).get("h1", 0) or 0
    risks = (rugcheck_report or {}).get("risks") or []
    risk_flags = [
        {"name": r.get("name"), "level": r.get("level")}
        for r in risks if isinstance(r, dict)
    ]
    return {
        "mint": mint_address,
        "score": result.score,
        "is_high_potential": result.is_high_potential,
        "liquidity_usd": result.liquidity_usd,
        "market_cap_usd": result.market_cap_usd,
        "volume_h1": volume_h1,
        "momentum_pct": momentum_pct,
        "risk_flags": risk_flags,
        "reasons": result.reasons,
        "potential_label": result.potential_label,
    }


INDEX_HTML = """<!doctype html><html><head><meta charset="utf-8">
<title>Memecoin Scanner</title>
<style>body{font-family:sans-serif;max-width:900px;margin:2em auto;padding:0 1em}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;padding:6px;text-align:left}
button{padding:8px 16px;margin:4px;cursor:pointer}input{padding:8px;width:420px;max-width:90%}</style>
</head><body>
<h1>Memecoin Scanner</h1>
<button id="scanNow" onclick="scanLatest()">Scan Now</button>
<span id="status"></span>
<h2>Monitored coins</h2>
<table><thead><tr><th>Mint</th><th>Score</th><th>Liquidity $</th><th>Volume 1h $</th><th>Risk</th></tr></thead>
<tbody id="results"></tbody></table>
<h2>Check one coin</h2>
<input id="mint" placeholder="mint address"><button onclick="scanOne()">Check</button>
<table><thead><tr><th>Mint</th><th>Score</th><th>Liquidity $</th><th>Risk</th></tr></thead>
<tbody id="single"></tbody></table>
<script>
function riskText(r){return (r.risk_flags||[]).map(f=>f.name+' ('+f.level+')').join('; ')||'-';}
function row(r){return '<tr><td>'+r.mint+'</td><td>'+r.score+'</td><td>'+r.liquidity_usd+'</td><td>'+(r.volume_h1??'-')+'</td><td>'+riskText(r)+'</td></tr>';}
async function scanLatest(){document.getElementById('status').textContent='Scanning...';
 const res=await fetch('/api/scan-latest',{method:'POST'});const data=await res.json();
 const list=Array.isArray(data)?data:(data.results||[]);
 document.getElementById('results').innerHTML=list.map(row).join('');
 document.getElementById('status').textContent='Done ('+list.length+' coins)';}
async function scanOne(){const m=document.getElementById('mint').value.trim();if(!m)return;
 const res=await fetch('/api/scan/'+encodeURIComponent(m),{method:'POST'});const data=await res.json();
 document.getElementById('single').innerHTML=row(data);}
</script></body></html>"""


@app.route("/")
def index():
    if request.args.get("format") == "json" or "application/json" in (request.headers.get("Accept") or ""):
        with _monitoring_lock:
            _status["currently_monitoring"] = list(_monitoring)
        return jsonify({"status": "ok", **_status})
    return INDEX_HTML


@app.route("/health")
def health():
    with _monitoring_lock:
        _status["currently_monitoring"] = list(_monitoring)
    return {"status": "ok", **_status}


@app.route("/api/scan/<mint_address>", methods=["POST"])
def api_scan_one(mint_address):
    try:
        result = asyncio.run(scan_coin(mint_address))
    except Exception as e:
        log.warning("On-demand scan fail за %s: %s", mint_address, e)
        return jsonify({"mint": mint_address, "error": str(e)}), 500
    return jsonify(result)


@app.route("/api/scan-latest", methods=["POST"])
def api_scan_latest():
    with _monitoring_lock:
        mints = list(_monitoring)

    async def _scan_all():
        return list(await asyncio.gather(*(scan_coin(m) for m in mints)))

    try:
        results = asyncio.run(_scan_all())
    except Exception as e:
        log.warning("On-demand scan-latest fail: %s", e)
        return jsonify({"error": str(e)}), 500
    return jsonify(results)


@app.route("/test-email")
def test_email():
    """Изпраща тестов email алърт през Resend, за да провериш дали
    ALERT_EMAIL_ENABLED/RESEND_API_KEY/ALERT_EMAIL_TO са настроени правилно.
    Просто отвори този URL в браузъра веднъж."""
    from scoring import MemeScoreResult
    fake = MemeScoreResult(
        mint="TestMint1111111111111111111111111111111111",
        score=99,
        reasons=["Това е тестов алърт за проверка на Resend интеграцията."],
        liquidity_usd=12345,
        market_cap_usd=45000,
        potential_label="🚀 Потенциален голям runner (нисък market cap + силен ранен моментум + висок обем) - но силно спекулативно, повечето такива монети пак отиват на 0",
        raw={},
    )
    send_alert(fake)
    if not config.ALERT_EMAIL_ENABLED:
        return {"sent": False, "reason": "ALERT_EMAIL_ENABLED е false - провери Render Environment Variables."}
    if not config.RESEND_API_KEY:
        return {"sent": False, "reason": "RESEND_API_KEY липсва - провери Render Environment Variables."}
    return {"sent": True, "to": config.ALERT_EMAIL_TO, "note": "Провери логовете (Logs таб) и пощата си."}


def _safe_float(val) -> float:
    try:
        return float(val)
    except (TypeError, ValueError):
        return 0.0


async def _refresh_market_data_loop():
    """Централен loop - batch-ва DexScreener заявки за ВСИЧКИ следени в
    момента монети наведнъж (виж data_sources.get_dexscreener_pairs_batch),
    вместо всяка от monitor_token() task-овете да пита поотделно. Тече
    независимо от индивидуалните monitor_token() задачи, докато процесът е
    жив - виж коментара при _market_data_cache по-горе за причината."""
    while True:
        try:
            with _monitoring_lock:
                mints = list(_monitoring)
            if mints:
                fresh = await asyncio.to_thread(get_dexscreener_pairs_batch, mints)
                _market_data_cache.update(fresh)
                # чистим кеша от монети, които вече не следим (излезли от
                # monitor_token поради timeout/алърт/грешка) - да не расте
                # неограничено през дни наред работа на процеса.
                mints_set = set(mints)
                for stale_mint in list(_market_data_cache.keys()):
                    if stale_mint not in mints_set:
                        _market_data_cache.pop(stale_mint, None)
        except Exception as e:
            log.warning("Грешка в централния market-data refresh loop: %s", e)
        await asyncio.sleep(config.POLL_INTERVAL_SECONDS)


async def monitor_token(mint: str):
    """Следи монетата на живо и праща алърт веднага щом пресече прага -
    вместо да чака фиксирано изчакване и да провери само веднъж."""
    with _monitoring_lock:
        _monitoring.add(mint)
    try:
        await asyncio.sleep(config.INITIAL_INDEX_DELAY_SECONDS)

        # RugCheck: опитваме пак на всеки poll, ДОКАТО не получим реален
        # доклад - веднага след graduation монетата често още не е
        # индексирана (празен report), а преди кодът приемаше "няма флагове"
        # (защото няма доклад изобщо) като "монетата е чиста" и я score-ваше
        # високо въпреки нулева реална риск-проверка.
        #
        # ВАЖНО (17.09, реален rug pull малко след алърт - TWOSIDES/68KXLo...):
        # преди спирахме да питаме RugCheck ОТНОВО веднага щом получим първи
        # непразен доклад - и после го ползвахме до 45 мин напред, без да го
        # опресняваме. Проблемът: RugCheck-ските рискови флагове (Low
        # Liquidity, LP lock %, insider клъстъри) се менят в реално време
        # заедно с монетата - ако първият доклад е хванат рано (преди
        # ликвидността да е пропаднала или insider клъстъри да са открити),
        # монетата може да мине филтрите на poll #1-2 с "чист" стар доклад,
        # докато реалната картина вече се е влошила. Затова сега опресняваме
        # RugCheck периодично (на всеки config.RUGCHECK_REFRESH_EVERY_N_POLLS
        # проверки), не само докато е бил празен - живата DexScreener
        # ликвидност/цена вече се опресняват на всеки poll, но RugCheck
        # флаговете не бяха. Пазим стария доклад, ако новата заявка се провали
        # временно (НЕ го трием заради мрежова грешка).
        rugcheck_report = await asyncio.to_thread(get_rugcheck_report, mint)

        first_price = None
        peak_price = None
        consecutive_high_potential = 0
        deadline = datetime.now(timezone.utc) + timedelta(minutes=config.MONITOR_WINDOW_MINUTES)
        poll_num = 0

        while datetime.now(timezone.utc) < deadline:
            poll_num += 1
            should_refresh_rugcheck = (not rugcheck_report) or (poll_num % config.RUGCHECK_REFRESH_EVERY_N_POLLS == 0)
            if should_refresh_rugcheck:
                fresh_rugcheck = await asyncio.to_thread(get_rugcheck_report, mint)
                if fresh_rugcheck:
                    rugcheck_report = fresh_rugcheck
            # Четем от споделения кеш (пълни се от _refresh_market_data_loop),
            # НЕ директна HTTP заявка тук - виж коментара при _market_data_cache.
            pairs = _market_data_cache.get(mint) or []
            best_pair = pairs[0] if pairs else {}
            price = _safe_float(best_pair.get("priceUsd"))

            if first_price is None and price:
                first_price = price
            if price:
                peak_price = max(peak_price, price) if peak_price else price
            momentum_pct = ((price - first_price) / first_price * 100) if (first_price and price) else 0.0
            drawdown_pct = ((peak_price - price) / peak_price * 100) if (peak_price and price) else 0.0

            result = score_token(mint, best_pair, rugcheck_report, momentum_pct)
            log.info(
                "[%s] poll #%d score=%.1f моментум=%.1f%% спад_от_пика=%.1f%% ликвидност=$%.0f (%s)",
                mint, poll_num, result.score, momentum_pct, drawdown_pct, result.liquidity_usd,
                "; ".join(result.reasons),
            )

            # Защита срещу "купуване на върха" / еднократен spike - виж
            # config.MIN_POLLS_BEFORE_ALERT. РЕАЛЕН БЪГ (17.09, TWOSIDES/
            # 68KXLo... rug pull малко след алърт): преди тук проверявахме
            # "poll_num >= MIN_POLLS_BEFORE_ALERT" - т.е. САМО колко общо
            # проверки сме направили откакто следим монетата, НЕ колко от
            # тях подред са били над прага. Монета можеше да е боклук на
            # poll #1-2 и да получи ЕДИНСТВЕН случаен (wash-trading) spike
            # точно на poll #3 - и понеже 3 >= MIN_POLLS_BEFORE_ALERT(3), се
            # третираше като "потвърдено" и пращахме алърт веднага, без
            # реално нито едно предишно потвърждение. Сега броим ПОСЛЕДОВАТЕЛНИ
            # high-potential резултати (нулира се веднага щом score падне под
            # прага) - същия принцип, който вече ползваме в PennyStockScanner.
            if result.is_high_potential:
                consecutive_high_potential += 1
            else:
                consecutive_high_potential = 0

            if result.is_high_potential:
                already_rolling_over = drawdown_pct >= config.PEAK_DRAWDOWN_STOP_PCT
                confirmed = consecutive_high_potential >= config.MIN_POLLS_BEFORE_ALERT
                if confirmed and not already_rolling_over and config.ALERT_EMAIL_ENABLED and not can_send_now():
                    # ВАЖНО (18.09, по изричен избор на потребителя): монетата
                    # Е потвърдена и безопасна точно СЕГА, но anti-spam
                    # темпото (друг алърт е пратен наскоро - MIN_EMAIL_
                    # INTERVAL_SECONDS/MAX_EMAILS_PER_DAY) не позволява email
                    # този момент. НЕ break-ваме и НЕ пращаме стари данни по-
                    # късно - просто продължаваме да следим монетата (while
                    # цикълът продължава) и ще пробваме пак на СЛЕДВАЩИЯ poll
                    # с изцяло ПРЕСНИ данни (нов drawdown/score от кеша, и
                    # изцяло нова финална live проверка, ако темпото вече е
                    # освободено тогава) - вместо да губим готова, потвърдена
                    # монета само защото друг алърт е излязъл секунди по-рано.
                    log.info(
                        "%s: score е потвърден (%.1f), НО anti-spam темпото не позволява email точно сега - "
                        "продължавам да следя и ще пробвам пак на следващия poll с прясна проверка.",
                        mint, result.score,
                    )
                elif confirmed and not already_rolling_over:
                    # Финална live проверка "в последната секунда" - виж
                    # config.FINAL_CHECK_MAX_DRAWDOWN_PCT. Директна свежа
                    # DexScreener заявка (НЕ кеша, който е до
                    # POLL_INTERVAL_SECONDS стар) точно преди да пратим -
                    # хваща случая, в който монетата пада МЕЖДУ последното
                    # потвърждение и реалния момент на изпращане.
                    final_pairs = await asyncio.to_thread(get_dexscreener_pairs, mint)
                    final_best_pair = final_pairs[0] if final_pairs else best_pair
                    final_price = _safe_float(final_best_pair.get("priceUsd")) or price
                    final_drawdown_pct = (
                        ((peak_price - final_price) / peak_price * 100)
                        if (peak_price and final_price) else drawdown_pct
                    )
                    # Освен спад в цената, проверяваме и живата ликвидност точно
                    # преди изпращане (18.09, след преглед на кода - "liquidity
                    # rug" чрез изтегляне на пула не винаги удря цената веднага
                    # в СЪЩИЯ момент, но е директен, недвусмислен сигнал сам по
                    # себе си - ако ликвидността точно СЕГА е под минимума, няма
                    # смисъл да чакаме драудаун-а да го "настигне").
                    final_liquidity_usd = (final_best_pair.get("liquidity") or {}).get("usd", 0) or 0
                    liquidity_collapsed = final_liquidity_usd < config.MIN_LIQUIDITY_USD
                    if final_drawdown_pct >= config.FINAL_CHECK_MAX_DRAWDOWN_PCT:
                        log.info(
                            "%s: финалната проверка точно преди изпращане показа спад %.1f%% от пика "
                            "(над прага %.1f%%) - отменям алърта в последния момент, монетата вече пада.",
                            mint, final_drawdown_pct, config.FINAL_CHECK_MAX_DRAWDOWN_PCT,
                        )
                    elif liquidity_collapsed:
                        log.info(
                            "%s: финалната проверка точно преди изпращане показа ликвидност $%.0f "
                            "(под минимума $%.0f) - отменям алърта в последния момент, изглежда като "
                            "изтегляне на ликвидността в движение.",
                            mint, final_liquidity_usd, config.MIN_LIQUIDITY_USD,
                        )
                    elif send_alert(result):
                        # send_alert() връща False САМО ако anti-spam темпото
                        # блокира точно в този момент (виж notifier.py) - тук
                        # все пак е възможно (рядко) заради race condition:
                        # друга едновременно следена монета (различен asyncio
                        # task) да е "изпреварила" и да е използвала темпото
                        # МЕЖДУ can_send_now() проверката по-горе и реалния
                        # HTTP send тук. True тук значи наистина обработено
                        # (пратено, или email-ите изключени/грешка - виж
                        # notifier.py::send_alert за пълния списък).
                        _status["last_alert_at"] = datetime.now(timezone.utc).isoformat()
                        break
                    else:
                        log.info(
                            "%s: anti-spam темпото блокира изпращането точно в последния момент (race с друга "
                            "монета) - продължавам да следя и ще пробвам пак на следващия poll.",
                            mint,
                        )
                elif already_rolling_over:
                    log.info(
                        "%s: score е висок (%.1f), НО цената вече е паднала %.1f%% от пика - "
                        "най-вероятно върхът е изпуснат, пропускам алърта.",
                        mint, result.score, drawdown_pct,
                    )
                else:
                    log.info(
                        "%s: score е висок (%.1f) - %d/%d последователни проверки над прага, "
                        "чакам още преди да пратя алърт.",
                        mint, result.score, consecutive_high_potential, config.MIN_POLLS_BEFORE_ALERT,
                    )

            await asyncio.sleep(config.POLL_INTERVAL_SECONDS)
        else:
            log.info("%s: monitoring прозорецът (%d мин) изтече без сигнал.", mint, config.MONITOR_WINDOW_MINUTES)

    except Exception as e:
        log.warning("Грешка при следене на %s: %s", mint, e)
    finally:
        with _monitoring_lock:
            _monitoring.discard(mint)
        mark_seen(mint, _seen)
        _status["seen_count"] = len(_seen)


async def on_migration(event: dict):
    mint = extract_mint_address(event)
    if not mint or mint in _seen or mint in _monitoring:
        return
    _status["last_migration_at"] = datetime.now(timezone.utc).isoformat()
    log.info("Ново graduation събитие: %s - започвам реално-времево следене.", mint)
    await monitor_token(mint)


def _run_async_loop():
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    async def _dispatch(event):
        # всяко събитие се обработва в собствена task, за да следим много
        # монети едновременно, без да блокираме слушането на нови graduation-и
        loop.create_task(on_migration(event))

    _status["started_at"] = datetime.now(timezone.utc).isoformat()
    loop.create_task(_refresh_market_data_loop())
    loop.run_until_complete(listen_for_migrations(_dispatch))


def _self_ping_loop():
    """Праща GET заявка към собствения публичен Render URL на всеки
    config.KEEP_ALIVE_PING_MINUTES минути.

    ЗАЩО (18.09, по оплакване на потребителя "от час и нещо няма никакви
    сигнали"): Render безплатният план приспива service-а след 15 мин БЕЗ
    входящ HTTP трафик (виж README) - докато спи, WebSocket връзката към
    PumpPortal се къса и се пропускат ВСИЧКИ graduation събития дотогава.
    Досега единствената защита беше ВЪНШЕН pinger (cron-job.org/UptimeRobot),
    който трябваше потребителят сам да настрои и поддържа активен - ако не е
    бил реално пуснат (или е спрял тихо), нищо вътре в бота не забелязва
    това. Затова сега ботът сам си праща заявка към собствения публичен
    адрес - Render автоматично слага RENDER_EXTERNAL_URL env variable-а с
    точно този адрес, затова не се налага да го въвеждаме ръчно.

    Ако RENDER_EXTERNAL_URL липсва (напр. локално стартиране, или хостинг
    без публичен URL) - просто прескачаме тихо, самопроверката не е
    приложима. Външният pinger пак е добра ДОПЪЛНИТЕЛНА защита (различен
    произход на трафика), но вече не е единствената линия."""
    external_url = os.getenv("RENDER_EXTERNAL_URL")
    if not external_url:
        log.info("RENDER_EXTERNAL_URL не е зададен (вероятно локално стартиране) - self-ping е изключен.")
        return
    log.info(
        "Self-ping активен: %s на всеки %d мин (пази Render service-а буден).",
        external_url, config.KEEP_ALIVE_PING_MINUTES,
    )
    while True:
        time.sleep(config.KEEP_ALIVE_PING_MINUTES * 60)
        try:
            requests.get(external_url, timeout=10)
            log.info("Self-ping към %s - ОК.", external_url)
        except Exception as e:
            log.warning("Self-ping към %s се провали: %s (ще пробвам пак след %d мин).", external_url, e, config.KEEP_ALIVE_PING_MINUTES)


def main():
    # _startup_self_check() вече е извикана веднъж при импортиране на модула
    # (виж по-горе, ПРЕДИ load_seen()) - не се налага втори път тук.
    thread = threading.Thread(target=_run_async_loop, daemon=True)
    thread.start()
    ping_thread = threading.Thread(target=_self_ping_loop, daemon=True)
    ping_thread.start()
    app.run(host="0.0.0.0", port=config.PORT)


if __name__ == "__main__":
    main()
