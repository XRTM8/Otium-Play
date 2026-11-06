//! JNI is deliberately a thin boundary; provider work and response ownership live in Rust.
use super::*;
use jni::{
    objects::{JObject, JString},
    sys::{jbyteArray, jint, jlong, jstring},
    JNIEnv,
};
use std::sync::atomic::{AtomicI64, Ordering};

struct LiveStream {
    body: StreamBody,
    touched: Instant,
}
type Streams = HashMap<i64, Arc<Mutex<LiveStream>>>;
fn streams() -> &'static Mutex<Streams> {
    static STREAMS: OnceLock<Mutex<Streams>> = OnceLock::new();
    STREAMS.get_or_init(|| Mutex::new(HashMap::new()))
}
fn string(env: &mut JNIEnv, input: &JString) -> Result<String> {
    env.get_string(input)
        .map(|s| s.into())
        .map_err(|_| "Invalid Java string".into())
}
fn output(env: &mut JNIEnv, text: String) -> jstring {
    env.new_string(text)
        .map(|s| s.into_raw())
        .unwrap_or(std::ptr::null_mut())
}

#[no_mangle]
pub extern "system" fn Java_com_krmzi_app_RustApi_request(
    mut env: JNIEnv,
    _object: JObject,
    url: JString,
) -> jstring {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let url = string(&mut env, &url)?;
        Ok::<_, String>(runtime().block_on(engine().request(&url)).value.to_string())
    }));
    let text = match result {
        Ok(Ok(text)) => text,
        Ok(Err(error)) => json!({"error":error,"isSuccess":false}).to_string(),
        Err(_) => json!({"error":"Native engine error","isSuccess":false}).to_string(),
    };
    output(&mut env, text)
}

#[no_mangle]
pub extern "system" fn Java_com_krmzi_app_RustApi_open(
    mut env: JNIEnv,
    _object: JObject,
    url: JString,
    range: JString,
) -> jstring {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let url = string(&mut env, &url)?;
        let range = string(&mut env, &range)?;
        let response = runtime()
            .block_on(engine().open(&url, if range.is_empty() { None } else { Some(&range) }))?;
        let mut streams = streams().lock().unwrap_or_else(|e| e.into_inner());
        streams.retain(|_, entry| {
            entry
                .try_lock()
                .map(|s| s.touched.elapsed() < Duration::from_secs(90))
                .unwrap_or(true)
        });
        if streams.len() >= 48 {
            return Err("Too many open media requests".into());
        }
        static NEXT: AtomicI64 = AtomicI64::new(1);
        let handle = NEXT.fetch_add(1, Ordering::Relaxed);
        let metadata=json!({"handle":handle,"status":response.status,"mime":response.mime,"headers":response.headers}).to_string();
        streams.insert(
            handle,
            Arc::new(Mutex::new(LiveStream {
                body: response.body,
                touched: Instant::now(),
            })),
        );
        Ok::<_, String>(metadata)
    }));
    let text=match result {Ok(Ok(text))=>text,Ok(Err(error))=>json!({"handle":0,"status":502,"mime":"text/plain","headers":{"Cache-Control":"no-store"},"error":error}).to_string(),Err(_)=>json!({"handle":0,"status":502,"mime":"text/plain","error":"Native stream error"}).to_string()};
    output(&mut env, text)
}

#[no_mangle]
pub extern "system" fn Java_com_krmzi_app_RustApi_read(
    mut env: JNIEnv,
    _object: JObject,
    handle: jlong,
    size: jint,
) -> jbyteArray {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let stream = streams()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&handle)
            .cloned()
            .ok_or("Stream closed")?;
        let mut stream = stream.lock().unwrap_or_else(|e| e.into_inner());
        stream.touched = Instant::now();
        let bytes = runtime().block_on(stream.body.read(size.clamp(1, 65536) as usize))?;
        if bytes.is_empty() {
            streams()
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&handle);
        }
        Ok::<_, String>(bytes)
    }));
    match result {
        Ok(Ok(bytes)) => env
            .byte_array_from_slice(&bytes)
            .map(|v| v.into_raw())
            .unwrap_or(std::ptr::null_mut()),
        error => {
            streams()
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&handle);
            let message = match error {
                Ok(Err(error)) => error,
                _ => "Native read error".into(),
            };
            let _ = env.throw_new("java/io/IOException", message);
            std::ptr::null_mut()
        }
    }
}

#[no_mangle]
pub extern "system" fn Java_com_krmzi_app_RustApi_close(
    _env: JNIEnv,
    _object: JObject,
    handle: jlong,
) {
    let _ = std::panic::catch_unwind(|| {
        streams()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&handle);
    });
}

#[no_mangle]
pub extern "system" fn Java_com_krmzi_app_RustApi_trimMemory(_env: JNIEnv, _object: JObject) {
    let _ = std::panic::catch_unwind(|| {
        engine().trim_memory(false);
        streams()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|_, entry| {
                entry
                    .try_lock()
                    .map(|s| s.touched.elapsed() < Duration::from_secs(30))
                    .unwrap_or(true)
            });
    });
}

#[no_mangle]
pub extern "system" fn Java_com_krmzi_app_RustApi_clearMemoryCache(_env: JNIEnv, _object: JObject) {
    let _ = std::panic::catch_unwind(|| engine().trim_memory(true));
}
