//! Keeps the PC from sleeping while an update or a recovery runs (FR19 item 7): a PC that sleeps in the middle of a fence leaves the
//! tills behind a maintenance page until it wakes. `SetThreadExecutionState` is per thread, so a guard is `!Send`: it is dropped on
//! the thread that took it, whether the operation ends, fails or unwinds from a panic.
use std::marker::PhantomData;

/// While it lives, the PC does not sleep. Dropping it gives sleep back (`ES_CONTINUOUS` alone).
pub struct KeepAwake(PhantomData<*const ()>);
impl KeepAwake {
    pub fn new() -> KeepAwake {
        crate::sys::set_thread_awake(true);
        KeepAwake(PhantomData)
    }
}
impl Default for KeepAwake { fn default() -> Self { Self::new() } }
impl Drop for KeepAwake { fn drop(&mut self) { crate::sys::set_thread_awake(false); } }
