# Runbook del propietario: el gancho de bloqueo falla cerrado / Owner runbook: the lockout hook fails closed

## Español

### Qué ve el propietario
- Los cajeros no pueden iniciar sesión con su PIN.
- `posctl status` muestra `LOCKOUT_HOOK_INACTIVE` o `AUTH_HOOK_ERROR`.
- `posctl health --canary` termina con código de salida 22.

### Por qué se bloquea a propósito
El gancho de bloqueo limita los intentos de PIN equivocados. Si el sistema no puede confirmar que el gancho responde, rechaza todos los inicios de sesión con PIN. Es mejor que nadie entre un rato a que alguien pruebe PINs sin límite. Falla cerrado por diseño.

Ningún interruptor, variable de entorno ni PIN (tampoco el del administrador) apaga el bloqueo. La única salida es reparar el gancho, con los pasos siguientes en este orden.

### Recuperación, en orden
1. Ejecute `posctl health --canary --json` y guarde la salida.
2. Revise que `gotrue.env` conserve las dos variables del gancho. `posctl restart --component auth` no reescribe nada; `posctl pack activate --version <versión actual>` reescribe la configuración.
3. Ejecute `posctl restart`.
4. Si la base de datos perdió la función del gancho, reinstale el paquete: `posctl pack install --file <ruta del archivo .pospack>` y después `posctl pack activate --set-current`. Nunca edite la base de datos a mano.
5. Si sigue fallando, reúna la carpeta `logs\SupermarketPOS-Auth\` y llame al proveedor.

### Cómo leer el registro de GoTrue
- Busque en `logs\SupermarketPOS-Auth\` la línea `Hook errored out`. Significa que el gancho falló al responder: es la causa de que se rechacen los inicios de sesión.
- El gancho tiene un límite de 2 segundos. Si una migración o una transacción larga mantiene bloqueada la tabla `pin_attempts`, el gancho no responde a tiempo y se detienen todos los inicios de sesión hasta que esa operación termine. Espere a que termine la actualización o la copia en curso y vuelva a ejecutar `posctl health --canary --json`.

## English

### What the owner sees
- Cashiers cannot sign in with their PIN.
- `posctl status` shows `LOCKOUT_HOOK_INACTIVE` or `AUTH_HOOK_ERROR`.
- `posctl health --canary` exits with code 22.

### Why it fails closed on purpose
The lockout hook limits wrong-PIN attempts. When the system cannot confirm the hook is answering, it refuses every PIN sign-in. A short period where nobody can sign in is better than anyone being able to guess PINs without limit. It fails closed by design.

No switch, environment variable or PIN (the administrator's included) turns the lockout off. The only way out is to repair the hook, using the steps below in this order.

### Recovery, in order
1. Run `posctl health --canary --json` and keep the output.
2. Check that `gotrue.env` still carries the two hook variables. `posctl restart --component auth` rewrites nothing; `posctl pack activate --version <current version>` rewrites the configuration.
3. Run `posctl restart`.
4. If the database lost the hook function, re-install the pack: `posctl pack install --file <path to the .pospack file>`, then `posctl pack activate --set-current`. Never edit the database by hand.
5. If it still fails, collect the `logs\SupermarketPOS-Auth\` folder and call the vendor.

### Reading the GoTrue log
- Look in `logs\SupermarketPOS-Auth\` for the line `Hook errored out`. It means the hook failed to answer; that is why sign-ins are being refused.
- The hook has a 2 second timeout. A migration or a long transaction holding a lock on the `pin_attempts` table makes the hook miss that deadline and stops all sign-ins until the operation finishes. Wait for the running update or backup to end, then run `posctl health --canary --json` again.
