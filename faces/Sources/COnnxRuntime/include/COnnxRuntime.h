#pragma once

#include <stddef.h>
#include <stdint.h>

typedef struct FESession FESession;

const char *fe_runtime_version(void);

FESession *fe_session_open(const char *model_path, const char *gpu_cache, const char *dim_name, int64_t dim_value,
                           char *error, size_t error_size);

int fe_session_run(FESession *session, const float *input, const int64_t *shape, size_t rank,
                   float *const *outputs, const size_t *counts, size_t output_count,
                   char *error, size_t error_size);

void fe_session_close(FESession *session);
