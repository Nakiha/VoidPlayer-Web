#define _GNU_SOURCE
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
static volatile sig_atomic_t stopping;
static volatile sig_atomic_t child=-1;
static void stop(int sig){int saved_errno=errno;stopping=sig;if(child>0)kill(child,SIGKILL);errno=saved_errno;}
static int limit(int kind,const char *text){char *end;errno=0;unsigned long long n=strtoull(text,&end,10);if(errno||!n||*end)return -1;struct rlimit l={(rlim_t)n,(rlim_t)n};return setrlimit(kind,&l);}
int main(int argc,char **argv){
 if(argc<5)return 64;
 pid_t parent=getppid();if(prctl(PR_SET_PDEATHSIG,SIGTERM)||getppid()!=parent)return 70;
 struct sigaction action={0};action.sa_handler=stop;sigemptyset(&action.sa_mask);sigaction(SIGTERM,&action,NULL);sigaction(SIGINT,&action,NULL);
 struct timespec start,end;clock_gettime(CLOCK_MONOTONIC,&start);
 /* No native child starts before the service durably owns this supervisor. */
 char gate=0;ssize_t count;
 do{count=read(STDIN_FILENO,&gate,1);}while(count<0&&errno==EINTR&&!stopping);
 if(stopping||count!=1||gate!='G')return 70;
 pid_t supervisor=getpid();child=fork();if(child<0)return 71;
 if(child==0){if(prctl(PR_SET_PDEATHSIG,SIGKILL)||getppid()!=supervisor)_exit(70);
  if(limit(RLIMIT_CPU,argv[1])||limit(RLIMIT_AS,argv[2])||limit(RLIMIT_FSIZE,argv[3]))_exit(72);
  struct rlimit core={0,0};if(setrlimit(RLIMIT_CORE,&core))_exit(72);
  execv(argv[4],argv+4);_exit(73);
 }
 if(stopping)kill(child,SIGKILL);
 printf("VOIDPLAYER_VMAF_PID %ld\n",(long)child);fflush(stdout);
 int status=0;struct rusage usage;pid_t waited;
 do{waited=wait4(child,&status,0,&usage);}while(waited<0&&errno==EINTR);
 if(waited!=child)return 74;
 clock_gettime(CLOCK_MONOTONIC,&end);
 double wall=(end.tv_sec-start.tv_sec)*1000.0+(end.tv_nsec-start.tv_nsec)/1000000.0;
 double cpu=(usage.ru_utime.tv_sec+usage.ru_stime.tv_sec)*1000.0+(usage.ru_utime.tv_usec+usage.ru_stime.tv_usec)/1000.0;
 printf("VOIDPLAYER_VMAF_USAGE {\"cpuMs\":%.3f,\"wallMs\":%.3f,\"peakRssBytes\":%llu,\"exitCode\":%d,\"signal\":%d}\n",cpu,wall,(unsigned long long)usage.ru_maxrss*1024,WIFEXITED(status)?WEXITSTATUS(status):-1,WIFSIGNALED(status)?WTERMSIG(status):0);fflush(stdout);
 return stopping?128+stopping:WIFEXITED(status)?WEXITSTATUS(status):128+WTERMSIG(status);
}
