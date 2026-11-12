
/home/kaloyan/work/re/WoW/artifacts/clients/7.3.5.26972/analysis-x64/Wow-64.analysis.exe:     file format pei-x86-64


Disassembly of section .text:

0000000140d43b20 <.text+0xd42b20>:
   140d43b20:	48 89 5c 24 10       	mov    QWORD PTR [rsp+0x10],rbx
   140d43b25:	55                   	push   rbp
   140d43b26:	48 8d ac 24 70 ff ff 	lea    rbp,[rsp-0x90]
   140d43b2d:	ff 
   140d43b2e:	48 81 ec 90 01 00 00 	sub    rsp,0x190
   140d43b35:	8b 41 30             	mov    eax,DWORD PTR [rcx+0x30]
   140d43b38:	48 8b 51 20          	mov    rdx,QWORD PTR [rcx+0x20]
   140d43b3c:	48 c7 45 70 00 00 00 	mov    QWORD PTR [rbp+0x70],0x0
   140d43b43:	00 
   140d43b44:	48 c7 45 78 00 00 00 	mov    QWORD PTR [rbp+0x78],0x0
   140d43b4b:	00 
   140d43b4c:	48 8b d9             	mov    rbx,rcx
   140d43b4f:	4c 8d 49 38          	lea    r9,[rcx+0x38]
   140d43b53:	0f 10 45 70          	movups xmm0,XMMWORD PTR [rbp+0x70]
   140d43b57:	89 45 70             	mov    DWORD PTR [rbp+0x70],eax
   140d43b5a:	48 8b 41 28          	mov    rax,QWORD PTR [rcx+0x28]
   140d43b5e:	4c 8d 45 70          	lea    r8,[rbp+0x70]
   140d43b62:	0f 11 85 80 00 00 00 	movups XMMWORD PTR [rbp+0x80],xmm0
   140d43b69:	48 8d 0d 10 9d f3 00 	lea    rcx,[rip+0xf39d10]        # 0x141c7d880
   140d43b70:	48 89 45 78          	mov    QWORD PTR [rbp+0x78],rax
   140d43b74:	e8 f7 ac 4b 00       	call   0x1411fe870
   140d43b79:	85 c0                	test   eax,eax
   140d43b7b:	0f 84 38 03 00 00    	je     0x140d43eb9
   140d43b81:	3d 40 01 00 80       	cmp    eax,0x80000140
   140d43b86:	0f 84 2d 03 00 00    	je     0x140d43eb9
   140d43b8c:	48 8d 0d d5 9c f3 00 	lea    rcx,[rip+0xf39cd5]        # 0x141c7d868
   140d43b93:	45 33 c0             	xor    r8d,r8d
   140d43b96:	33 d2                	xor    edx,edx
   140d43b98:	e8 53 59 02 00       	call   0x140d694f0
   140d43b9d:	84 c0                	test   al,al
   140d43b9f:	0f 84 14 03 00 00    	je     0x140d43eb9
   140d43ba5:	48 8d 05 a4 08 65 00 	lea    rax,[rip+0x6508a4]        # 0x141394450
   140d43bac:	48 8d 15 b5 9c f3 00 	lea    rdx,[rip+0xf39cb5]        # 0x141c7d868
   140d43bb3:	48 8d 4c 24 30       	lea    rcx,[rsp+0x30]
   140d43bb8:	45 33 c9             	xor    r9d,r9d
   140d43bbb:	45 33 c0             	xor    r8d,r8d
   140d43bbe:	c7                   	.byte 0xc7
   140d43bbf:	44                   	rex.R
