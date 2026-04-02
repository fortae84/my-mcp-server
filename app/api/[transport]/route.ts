import { createMcpHandler } from 'mcp-handler'
import { z } from 'zod'
import { InferenceClient } from '@huggingface/inference'

const CITY_TIMEZONES: Record<string, { timezone: string; label: string }> = {
    seoul: { timezone: 'Asia/Seoul', label: '서울 (KST)' },
    new_york: { timezone: 'America/New_York', label: '뉴욕 (ET)' },
    chicago: { timezone: 'America/Chicago', label: '시카고 (CT)' },
    denver: { timezone: 'America/Denver', label: '덴버 (MT)' },
    los_angeles: { timezone: 'America/Los_Angeles', label: '로스앤젤레스 (PT)' }
}

const WMO_WEATHER_CODES: Record<number, string> = {
    0: '맑음', 1: '대체로 맑음', 2: '부분 흐림', 3: '흐림',
    45: '안개', 48: '서리 안개',
    51: '가벼운 이슬비', 53: '보통 이슬비', 55: '짙은 이슬비',
    61: '가벼운 비', 63: '보통 비', 65: '강한 비',
    71: '가벼운 눈', 73: '보통 눈', 75: '강한 눈', 77: '싸락눈',
    80: '가벼운 소나기', 81: '보통 소나기', 82: '강한 소나기',
    85: '가벼운 눈 소나기', 86: '강한 눈 소나기',
    95: '뇌우', 96: '우박 동반 뇌우', 99: '강한 우박 동반 뇌우'
}

const SERVER_START_TIME = Date.now()

const handler = createMcpHandler(
    (server) => {
        // ── greet ──────────────────────────────────────────────────────────
        server.registerTool(
            'greet',
            {
                description: '이름과 언어를 입력하면 인사말을 반환합니다.',
                inputSchema: {
                    name: z.string().describe('인사할 사람의 이름'),
                    language: z
                        .enum(['ko', 'en'])
                        .optional()
                        .default('en')
                        .describe('인사 언어 (기본값: en)')
                }
            },
            async ({ name, language }) => {
                const greeting =
                    language === 'ko'
                        ? `안녕하세요, ${name}님!`
                        : `Hey there, ${name}! 👋 Nice to meet you!`
                return { content: [{ type: 'text' as const, text: greeting }] }
            }
        )

        // ── calc ───────────────────────────────────────────────────────────
        server.registerTool(
            'calc',
            {
                description: '두 숫자와 연산자를 입력받아 사칙연산 결과를 반환합니다.',
                inputSchema: {
                    a: z.number().describe('첫 번째 숫자'),
                    b: z.number().describe('두 번째 숫자'),
                    operator: z.enum(['+', '-', '*', '/']).describe('연산자 (+, -, *, /)')
                }
            },
            async ({ a, b, operator }) => {
                let result: number
                if (operator === '+') result = a + b
                else if (operator === '-') result = a - b
                else if (operator === '*') result = a * b
                else {
                    if (b === 0)
                        return { content: [{ type: 'text' as const, text: '오류: 0으로 나눌 수 없습니다.' }] }
                    result = a / b
                }
                return { content: [{ type: 'text' as const, text: `${a} ${operator} ${b} = ${result!}` }] }
            }
        )

        // ── time ───────────────────────────────────────────────────────────
        server.registerTool(
            'time',
            {
                description: '특정 도시의 현재 시간을 반환합니다. 도시를 지정하지 않으면 전체 도시 목록을 반환합니다.',
                inputSchema: {
                    city: z
                        .enum(['seoul', 'new_york', 'chicago', 'denver', 'los_angeles', 'all'])
                        .optional()
                        .default('all')
                        .describe('조회할 도시 (seoul, new_york, chicago, denver, los_angeles, all)')
                }
            },
            async ({ city }) => {
                const now = new Date()
                const formatTime = (timezone: string) =>
                    now.toLocaleString('ko-KR', {
                        timeZone: timezone,
                        year: 'numeric', month: '2-digit', day: '2-digit',
                        hour: '2-digit', minute: '2-digit', second: '2-digit',
                        hour12: false
                    })
                let text: string
                if (city === 'all') {
                    text = Object.values(CITY_TIMEZONES)
                        .map(({ timezone, label }) => `${label}: ${formatTime(timezone)}`)
                        .join('\n')
                } else {
                    const { timezone, label } = CITY_TIMEZONES[city]
                    text = `${label}: ${formatTime(timezone)}`
                }
                return { content: [{ type: 'text' as const, text }] }
            }
        )

        // ── geocode ────────────────────────────────────────────────────────
        server.registerTool(
            'geocode',
            {
                description: '도시 이름이나 주소를 입력받아 위도와 경도 좌표를 반환합니다.',
                inputSchema: {
                    query: z.string().describe('검색할 도시명 또는 주소')
                }
            },
            async ({ query }) => {
                const url = new URL('https://nominatim.openstreetmap.org/search')
                url.searchParams.set('q', query)
                url.searchParams.set('format', 'json')
                url.searchParams.set('limit', '1')
                const response = await fetch(url.toString(), {
                    headers: { 'User-Agent': 'MCP-Geocode-Tool/1.0' }
                })
                const results = await response.json() as Array<{
                    lat: string; lon: string; display_name: string
                }>
                const text = (!results || results.length === 0)
                    ? `검색 결과가 없습니다: ${query}`
                    : `장소: ${results[0].display_name}\n위도: ${results[0].lat}\n경도: ${results[0].lon}`
                return { content: [{ type: 'text' as const, text }] }
            }
        )

        // ── get-weather ────────────────────────────────────────────────────
        server.registerTool(
            'get-weather',
            {
                description: '위도/경도 좌표와 예보 기간을 입력받아 현재 날씨와 일별 예보를 반환합니다.',
                inputSchema: {
                    latitude: z.number().min(-90).max(90).describe('위도 (-90 ~ 90)'),
                    longitude: z.number().min(-180).max(180).describe('경도 (-180 ~ 180)'),
                    forecast_days: z.number().int().min(1).max(16).optional().default(7).describe('예보 기간 (일, 기본값: 7)')
                }
            },
            async ({ latitude, longitude, forecast_days }) => {
                const url = new URL('https://api.open-meteo.com/v1/forecast')
                url.searchParams.set('latitude', String(latitude))
                url.searchParams.set('longitude', String(longitude))
                url.searchParams.set('forecast_days', String(forecast_days))
                url.searchParams.set('timezone', 'auto')
                url.searchParams.set('current', [
                    'temperature_2m', 'relative_humidity_2m', 'apparent_temperature',
                    'is_day', 'precipitation', 'weather_code', 'cloud_cover',
                    'surface_pressure', 'wind_speed_10m', 'wind_direction_10m'
                ].join(','))
                url.searchParams.set('daily', [
                    'weather_code', 'temperature_2m_max', 'temperature_2m_min',
                    'precipitation_sum', 'wind_speed_10m_max', 'sunrise', 'sunset'
                ].join(','))

                const response = await fetch(url.toString(), { headers: { 'User-Agent': 'MCP-Weather-Tool/1.0' } })
                if (!response.ok)
                    return { content: [{ type: 'text' as const, text: `날씨 API 오류: HTTP ${response.status}` }] }

                const data = await response.json() as {
                    timezone: string; timezone_abbreviation: string
                    current: {
                        time: string; temperature_2m: number; relative_humidity_2m: number
                        apparent_temperature: number; is_day: number; precipitation: number
                        weather_code: number; cloud_cover: number; surface_pressure: number
                        wind_speed_10m: number; wind_direction_10m: number
                    }
                    daily: {
                        time: string[]; weather_code: number[]; temperature_2m_max: number[]
                        temperature_2m_min: number[]; precipitation_sum: number[]
                        wind_speed_10m_max: number[]; sunrise: string[]; sunset: string[]
                    }
                }

                const describeWeatherCode = (code: number) =>
                    WMO_WEATHER_CODES[code] ?? `알 수 없음 (코드: ${code})`

                const c = data.current
                const currentLines = [
                    `[현재 날씨] (${c.time}, ${data.timezone} ${data.timezone_abbreviation})`,
                    `날씨 상태: ${describeWeatherCode(c.weather_code)}`,
                    `기온: ${c.temperature_2m}°C (체감: ${c.apparent_temperature}°C)`,
                    `습도: ${c.relative_humidity_2m}%`, `강수량: ${c.precipitation} mm`,
                    `구름량: ${c.cloud_cover}%`, `기압: ${c.surface_pressure} hPa`,
                    `풍속: ${c.wind_speed_10m} km/h (풍향: ${c.wind_direction_10m}°)`,
                    `낮/밤: ${c.is_day ? '낮' : '밤'}`
                ]
                const d = data.daily
                const forecastLines = [`\n[${forecast_days}일 예보]`]
                for (let i = 0; i < d.time.length; i++) {
                    forecastLines.push(
                        `${d.time[i]}: ${describeWeatherCode(d.weather_code[i])} | ` +
                        `최고 ${d.temperature_2m_max[i]}°C / 최저 ${d.temperature_2m_min[i]}°C | ` +
                        `강수 ${d.precipitation_sum[i]} mm | ` +
                        `최대풍속 ${d.wind_speed_10m_max[i]} km/h | ` +
                        `일출 ${d.sunrise[i].split('T')[1]} / 일몰 ${d.sunset[i].split('T')[1]}`
                    )
                }
                return { content: [{ type: 'text' as const, text: [...currentLines, ...forecastLines].join('\n') }] }
            }
        )

        // ── generate-image ─────────────────────────────────────────────────
        server.registerTool(
            'generate-image',
            {
                description: 'HuggingFace Inference API를 사용해 텍스트 프롬프트로 이미지를 생성합니다. (모델: FLUX.1-schnell)',
                inputSchema: {
                    prompt: z.string().describe('이미지 생성 프롬프트'),
                    num_inference_steps: z.number().int().min(1).max(10).optional().default(4).describe('추론 스텝 수 (1~10, 기본값: 4)')
                }
            },
            async ({ prompt, num_inference_steps }) => {
                const token = process.env.HF_TOKEN
                if (!token)
                    return { content: [{ type: 'text' as const, text: '오류: HF_TOKEN 환경변수가 설정되지 않았습니다.' }] }

                try {
                    const client = new InferenceClient(token)
                    const dataUrl = await client.textToImage(
                        {
                            provider: 'together',
                            model: 'black-forest-labs/FLUX.1-schnell',
                            inputs: prompt,
                            parameters: { num_inference_steps }
                        },
                        { outputType: 'dataUrl' }
                    )
                    const [header, base64] = dataUrl.split(',')
                    const mimeType = header.replace('data:', '').replace(';base64', '')
                    return { content: [{ type: 'image' as const, data: base64, mimeType: mimeType || 'image/png' }] }
                } catch (err) {
                    const message = err instanceof Error ? err.message : String(err)
                    return { content: [{ type: 'text' as const, text: `이미지 생성 실패: ${message}` }] }
                }
            }
        )

        // ── server-info resource ───────────────────────────────────────────
        server.registerResource(
            'server-info',
            'server://info',
            {
                title: '서버 상태 및 정보',
                description: '현재 MCP 서버의 상태, 버전, 등록된 도구 목록, 시스템 정보를 반환합니다.',
                mimeType: 'application/json'
            },
            async (uri) => {
                const uptimeMs = Date.now() - SERVER_START_TIME
                const uptimeSec = Math.floor(uptimeMs / 1000)
                const uptimeMin = Math.floor(uptimeSec / 60)
                const uptimeHour = Math.floor(uptimeMin / 60)
                const toMB = (bytes: number) => (bytes / 1024 / 1024).toFixed(2) + ' MB'
                const mem = process.memoryUsage()
                const info = {
                    server: {
                        name: 'my-mcp-server',
                        version: '1.0.0',
                        startedAt: new Date(SERVER_START_TIME).toISOString(),
                        uptime: `${uptimeHour}시간 ${uptimeMin % 60}분 ${uptimeSec % 60}초`
                    },
                    tools: ['greet', 'calc', 'time', 'geocode', 'get-weather', 'generate-image'],
                    system: {
                        platform: process.platform,
                        nodeVersion: process.version,
                        memory: { rss: toMB(mem.rss), heapUsed: toMB(mem.heapUsed), heapTotal: toMB(mem.heapTotal) }
                    },
                    currentTime: new Date().toISOString()
                }
                return { contents: [{ uri: uri.href, text: JSON.stringify(info, null, 2) }] }
            }
        )

        // ── code-review prompt ─────────────────────────────────────────────
        server.registerPrompt(
            'code-review',
            {
                title: 'Code Review',
                description: '코드를 입력받아 버그, 성능, 보안, 가독성 등을 종합적으로 리뷰하는 프롬프트입니다.',
                argsSchema: {
                    code: z.string().describe('리뷰할 코드'),
                    language: z.string().optional().describe('프로그래밍 언어 (예: TypeScript, Python 등)'),
                    focus: z
                        .enum(['전체', '버그', '성능', '보안', '가독성'])
                        .optional()
                        .default('전체')
                        .describe('리뷰 집중 항목 (기본값: 전체)')
                }
            },
            ({ code, language, focus }) => {
                const langStr = language ? `${language} ` : ''
                const focusGuide =
                    focus === '버그' ? '버그 및 잠재적 오류에 집중하여'
                    : focus === '성능' ? '성능 최적화 관점에서'
                    : focus === '보안' ? '보안 취약점 관점에서'
                    : focus === '가독성' ? '코드 가독성과 유지보수성 관점에서'
                    : '버그, 성능, 보안, 가독성을 종합적으로'

                return {
                    messages: [{
                        role: 'user' as const,
                        content: {
                            type: 'text' as const,
                            text: `아래 ${langStr}코드를 ${focusGuide} 리뷰해주세요.\n\n` +
                                `1. **버그 및 잠재적 오류**\n2. **성능**\n3. **보안**\n4. **가독성 & 유지보수성**\n5. **개선 제안** (수정 코드 예시 포함)\n\n` +
                                `\`\`\`${language?.toLowerCase() ?? ''}\n${code}\n\`\`\``
                        }
                    }]
                }
            }
        )
    },
    {},
    {
        basePath: '/api',
        maxDuration: 60,
        verboseLogs: false
    }
)

export { handler as GET, handler as POST, handler as DELETE }
