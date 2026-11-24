#include "COnnxRuntime.h"

#include <onnxruntime/onnxruntime_c_api.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

struct FESession {
  OrtSession *session;
  char *input_name;
  char **output_names;
  size_t output_count;
};

static const OrtApi *api;
static OrtEnv *env;
static pthread_once_t once = PTHREAD_ONCE_INIT;

static void init(void) {
  api = OrtGetApiBase()->GetApi(ORT_API_VERSION);
  if (api == NULL) return;
  if (api->CreateEnv(ORT_LOGGING_LEVEL_ERROR, "face-engine", &env) != NULL) env = NULL;
}

static int failed(OrtStatus *status, char *error, size_t error_size) {
  if (status == NULL) return 0;
  snprintf(error, error_size, "%s", api->GetErrorMessage(status));
  api->ReleaseStatus(status);
  return 1;
}

const char *fe_runtime_version(void) { return OrtGetApiBase()->GetVersionString(); }

FESession *fe_session_open(const char *model_path, const char *gpu_cache, const char *dim_name, int64_t dim_value,
                           char *error, size_t error_size) {
  pthread_once(&once, init);
  if (api == NULL || env == NULL) {
    snprintf(error, error_size, "onnxruntime %d is not available", ORT_API_VERSION);
    return NULL;
  }
  OrtSessionOptions *options = NULL;
  OrtAllocator *allocator = NULL;
  FESession *result = calloc(1, sizeof(FESession));
  if (failed(api->CreateSessionOptions(&options), error, error_size)) goto fail;
  if (failed(api->AddFreeDimensionOverrideByName(options, dim_name, dim_value), error, error_size)) goto fail;
  if (failed(api->AddSessionConfigEntry(options, "session.intra_op.allow_spinning", "0"), error, error_size))
    goto fail;
  if (failed(api->DisableCpuMemArena(options), error, error_size)) goto fail;
  if (gpu_cache != NULL) {
    const char *keys[] = {"ModelFormat", "MLComputeUnits", "ModelCacheDirectory"};
    const char *values[] = {"MLProgram", "CPUAndGPU", gpu_cache};
    if (failed(api->SessionOptionsAppendExecutionProvider(options, "CoreML", keys, values, 3), error, error_size))
      goto fail;
  }
  if (failed(api->CreateSession(env, model_path, options, &result->session), error, error_size)) goto fail;
  if (failed(api->GetAllocatorWithDefaultOptions(&allocator), error, error_size)) goto fail;
  if (failed(api->SessionGetInputName(result->session, 0, allocator, &result->input_name), error, error_size))
    goto fail;
  if (failed(api->SessionGetOutputCount(result->session, &result->output_count), error, error_size)) goto fail;
  result->output_names = calloc(result->output_count, sizeof(char *));
  for (size_t i = 0; i < result->output_count; i++) {
    if (failed(api->SessionGetOutputName(result->session, i, allocator, &result->output_names[i]), error,
               error_size))
      goto fail;
  }
  api->ReleaseSessionOptions(options);
  return result;
fail:
  if (options != NULL) api->ReleaseSessionOptions(options);
  fe_session_close(result);
  return NULL;
}

int fe_session_run(FESession *session, const float *input, const int64_t *shape, size_t rank,
                   float *const *outputs, const size_t *counts, size_t output_count,
                   char *error, size_t error_size) {
  if (output_count != session->output_count) {
    snprintf(error, error_size, "the model has %zu outputs, not %zu", session->output_count, output_count);
    return -1;
  }
  size_t input_count = 1;
  for (size_t i = 0; i < rank; i++) input_count *= (size_t)shape[i];
  OrtMemoryInfo *memory = NULL;
  OrtValue *tensor = NULL;
  OrtValue **values = calloc(output_count, sizeof(OrtValue *));
  int status = -1;
  if (failed(api->CreateCpuMemoryInfo(OrtArenaAllocator, OrtMemTypeDefault, &memory), error, error_size)) goto done;
  if (failed(api->CreateTensorWithDataAsOrtValue(memory, (void *)input, input_count * sizeof(float), shape, rank,
                                                 ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT, &tensor),
             error, error_size))
    goto done;
  const char *input_names[] = {session->input_name};
  const OrtValue *inputs[] = {tensor};
  if (failed(api->Run(session->session, NULL, input_names, inputs, 1, (const char *const *)session->output_names,
                      output_count, values),
             error, error_size))
    goto done;
  for (size_t i = 0; i < output_count; i++) {
    OrtTensorTypeAndShapeInfo *info = NULL;
    size_t count = 0;
    float *data = NULL;
    if (failed(api->GetTensorTypeAndShape(values[i], &info), error, error_size)) goto done;
    OrtStatus *counted = api->GetTensorShapeElementCount(info, &count);
    api->ReleaseTensorTypeAndShapeInfo(info);
    if (failed(counted, error, error_size)) goto done;
    if (count != counts[i]) {
      snprintf(error, error_size, "output %zu holds %zu values, not %zu", i, count, counts[i]);
      goto done;
    }
    if (failed(api->GetTensorMutableData(values[i], (void **)&data), error, error_size)) goto done;
    memcpy(outputs[i], data, count * sizeof(float));
  }
  status = 0;
done:
  for (size_t i = 0; i < output_count; i++)
    if (values[i] != NULL) api->ReleaseValue(values[i]);
  free(values);
  if (tensor != NULL) api->ReleaseValue(tensor);
  if (memory != NULL) api->ReleaseMemoryInfo(memory);
  return status;
}

void fe_session_close(FESession *session) {
  if (session == NULL) return;
  OrtAllocator *allocator = NULL;
  if (api->GetAllocatorWithDefaultOptions(&allocator) == NULL) {
    if (session->input_name != NULL) allocator->Free(allocator, session->input_name);
    for (size_t i = 0; i < session->output_count && session->output_names != NULL; i++)
      if (session->output_names[i] != NULL) allocator->Free(allocator, session->output_names[i]);
  }
  free(session->output_names);
  if (session->session != NULL) api->ReleaseSession(session->session);
  free(session);
}
